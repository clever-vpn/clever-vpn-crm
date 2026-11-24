/**
 * 接口配置编辑器（`generic_json_v1`）。
 *
 * 目标：运营**不写 JSON**也能配完常见网关。固定结构用带标签的字段，动态 map 用 KV 行；
 * 高级 JSON 只做逃生口。所有值最终由 `toMapping()` 变成 `validateMapping` 认的对象，
 * 保存仍走网关原有的 `POST/PATCH /api/admin/gateways`。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Collapse,
  Input,
  Modal,
  Radio,
  Select,
  Space,
  Switch,
  Tabs,
  Tag,
  Typography,
  message,
} from "antd";

import {
  describeMapping,
  fromMapping,
  requiredChecks,
  toMapping,
  type GatewayMappingLike,
  type KvRow,
  type AuthState,
  type MappingFormState,
  type ResponseSignState,
  type SignState,
  type WhenInput,
} from "../mapping-form";
import { OFFICIAL_TEMPLATES, parseTemplateText, type PaymentTemplate } from "../payment-templates";
import { api, ApiError, type GatewayAiDraft } from "../api";

interface Props {
  initial: unknown;
  methods: string[];
  endpoint: string | null;
  /** 每次表单/JSON 变化把当前映射交给父级；父级统一保存 */
  onChange: (mapping: GatewayMappingLike) => void;
  /** 父级据此做保存时校验：缺必填或 JSON 有未应用修改 */
  onStatus: (status: { ready: boolean; missing: number; jsonDirty: boolean; warnings: string[] }) => void;
  /** 点过保存后，把第一个缺失字段滚进视野并标红 */
  attempted?: boolean;
  /** 导出模板时用的网关名 */
  gatewayName?: string;
  /** AI 配置助手是否已配置（服务端 `ai_ready`）；未配置时只展示说明 */
  aiReady?: boolean;
}

const FIELD_ROWS: {
  key: keyof MappingFormState["fields"];
  label: string;
  required?: boolean;
  hint?: string;
}[] = [
  { key: "merchant", label: "商户号字段", required: true, hint: "文档里的 pid / mchId / appid" },
  { key: "order_no", label: "订单号字段", required: true, hint: "out_trade_no / trade_order_id" },
  { key: "amount", label: "金额字段", required: true, hint: "money / total_fee / amount" },
  { key: "subject", label: "商品名字段", hint: "name / title；不传可留空" },
  { key: "notify_url", label: "回调地址字段", hint: "notify_url / notifyUrl；服务商后台已配可留空" },
  { key: "return_url", label: "返回地址字段", hint: "return_url / returnUrl；可选" },
  { key: "client_ip", label: "客户 IP 字段", hint: "clientip / ip；可选" },
  { key: "body", label: "商品描述字段", hint: "body / desc；可选" },
  { key: "channel", label: "支付方式字段", hint: "type / wayCode / code；没有渠道概念可留空" },
  { key: "timestamp", label: "时间戳字段", hint: "time / reqTime / requestTime；没有可留空" },
  { key: "nonce", label: "随机串字段", hint: "nonce_str；没有可留空" },
];

function clone(state: MappingFormState): MappingFormState {
  return JSON.parse(JSON.stringify(state)) as MappingFormState;
}

function Line({
  label,
  required,
  hint,
  error,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 10 }}>
      <div style={{ flex: "0 0 150px" }}>
        <Space size={4}>
          <Typography.Text>{label}</Typography.Text>
          {required && <Tag color="red">必填</Tag>}
        </Space>
      </div>
      <div style={{ flex: "1 1 auto", minWidth: 0 }}>
        {children}
        {hint && (
          <Typography.Text type="secondary" style={{ display: "block", fontSize: 12 }}>
            {hint}
          </Typography.Text>
        )}
        {error && (
          <Typography.Text className="mapping-field-error" type="danger" style={{ display: "block", fontSize: 12 }}>
            {error}
          </Typography.Text>
        )}
      </div>
    </div>
  );
}

function WhenEditor({
  value,
  onChange,
  hint,
}: {
  value: WhenInput;
  onChange: (next: WhenInput) => void;
  hint?: string;
}) {
  return (
    <Space direction="vertical" size={6} style={{ width: "100%" }}>
      <Input
        value={value.path}
        onChange={(e) => onChange({ ...value, path: e.target.value })}
        placeholder="字段路径，如 data.state"
      />
      <Select
        mode="tags"
        value={value.values}
        onChange={(values: string[]) => onChange({ ...value, values })}
        tokenSeparators={[",", "，"]}
        placeholder="值：一个值 = 等于；多个值 = 命中任一"
        style={{ width: "100%" }}
      />
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {hint ?? "一个值 = 等于；多个值 = 命中任一"}
      </Typography.Text>
    </Space>
  );
}

function KvEditor({
  rows,
  onChange,
  keyPlaceholder = "参数名",
  valuePlaceholder = "值",
  allowType = false,
  keyEditable = true,
  hint,
}: {
  rows: KvRow[];
  onChange: (rows: KvRow[]) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  allowType?: boolean;
  keyEditable?: boolean;
  hint?: string;
}) {
  const update = (index: number, patch: Partial<KvRow>): void => {
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };
  return (
    <Space direction="vertical" size={6} style={{ width: "100%" }}>
      {rows.map((row, i) => (
        <div key={i} style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <div style={{ flex: "0 0 180px" }}>
            <Input
              size="small"
              value={row.key}
              disabled={!keyEditable}
              onChange={(e) => update(i, { key: e.target.value })}
              placeholder={keyPlaceholder}
            />
          </div>
          <div style={{ flex: "1 1 auto", minWidth: 0 }}>
            <Input
              size="small"
              value={row.value}
              onChange={(e) => update(i, { value: e.target.value })}
              placeholder={valuePlaceholder}
            />
          </div>
          {allowType && (
            <div style={{ flex: "0 0 86px" }}>
              <Select
                size="small"
                value={row.type}
                onChange={(type: KvRow["type"]) => update(i, { type })}
                options={[
                  { value: "text", label: "文本" },
                  { value: "number", label: "数字" },
                ]}
              />
            </div>
          )}
          <div style={{ flex: "0 0 34px" }}>
            <Button size="small" type="text" danger onClick={() => onChange(rows.filter((_, idx) => idx !== i))}>
              删
            </Button>
          </div>
        </div>
      ))}
      {keyEditable && (
        <Button size="small" onClick={() => onChange([...rows, { key: "", value: "", type: "text" }])}>
          + 添加
        </Button>
      )}
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {hint}
      </Typography.Text>
    </Space>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ border: "1px solid #f0f0f0", borderRadius: 8, padding: "14px 16px", marginBottom: 14 }}>
      <Typography.Title level={5} style={{ margin: "0 0 12px" }}>{title}</Typography.Title>
      {children}
    </div>
  );
}

function SubTitle({ children }: { children: React.ReactNode }) {
  return (
    <Typography.Title level={5} style={{ margin: "16px 0 8px", fontSize: 13, color: "#666" }}>
      {children}
    </Typography.Title>
  );
}

function AuthEditor({ value, onChange }: { value: AuthState; onChange: (next: AuthState) => void }) {
  return (
    <Space direction="vertical" size={6} style={{ width: "100%" }}>
      <Space>
        <Switch checked={value.enabled} onChange={(enabled) => onChange({ ...value, enabled })} />
        <Typography.Text type="secondary">使用认证头；值里的 {"{key}"} 会替换成密钥</Typography.Text>
      </Space>
      {value.enabled && (
        <>
          <Input value={value.header} onChange={(e) => onChange({ ...value, header: e.target.value })} placeholder="Authorization" />
          <Input value={value.value} onChange={(e) => onChange({ ...value, value: e.target.value })} placeholder="Token {key}" />
        </>
      )}
    </Space>
  );
}

function SignEditor({
  title,
  value,
  onChange,
}: {
  title: string;
  value: SignState;
  onChange: (next: SignState) => void;
}) {
  return (
    <Line label={title}>
      <Space direction="vertical" size={6} style={{ width: "100%" }}>
        <Space>
          <Switch checked={value.enabled} onChange={(v) => onChange({ ...value, enabled: v })} />
          <Typography.Text type="secondary">{value.enabled ? "启用" : "不签名（仅易支付 V1 查单）"}</Typography.Text>
        </Space>
        {value.enabled && (
          <>
            <Input value={value.field} onChange={(e) => onChange({ ...value, field: e.target.value })} placeholder="签名字段，默认 sign" />
            <Select
              value={value.algo}
              onChange={(v) => onChange({ ...value, algo: v })}
              options={[{ value: "md5", label: "MD5" }, { value: "sha256", label: "SHA-256" }]}
              style={{ width: "100%" }}
            />
            <Input value={value.key_append} onChange={(e) => onChange({ ...value, key_append: e.target.value })} placeholder="密钥拼接，如 &key=" />
            <Select
              mode="tags"
              value={value.exclude}
              onChange={(v: string[]) => onChange({ ...value, exclude: v })}
              tokenSeparators={[",", "，"]}
              placeholder="排除字段，如 sign/sign_type"
              style={{ width: "100%" }}
            />
            <Space>
              <Switch checked={value.upper} onChange={(v) => onChange({ ...value, upper: v })} />
              <Typography.Text type="secondary">大写</Typography.Text>
              <Switch checked={value.encode} onChange={(v) => onChange({ ...value, encode: v })} />
              <Typography.Text type="secondary">URL 编码</Typography.Text>
            </Space>
          </>
        )}
      </Space>
    </Line>
  );
}

function ResponseSignEditor({
  title,
  value,
  onChange,
}: {
  title: string;
  value: ResponseSignState;
  onChange: (next: ResponseSignState) => void;
}) {
  return (
    <Line label={title}>
      <Space direction="vertical" size={6} style={{ width: "100%" }}>
        <Switch checked={value.enabled} onChange={(v) => onChange({ ...value, enabled: v })} />
        {value.enabled && (
          <>
            <Input value={value.field} onChange={(e) => onChange({ ...value, field: e.target.value })} placeholder="签名字段路径，如 sign 或 data.sign" />
            <Input value={value.data_path} onChange={(e) => onChange({ ...value, data_path: e.target.value })} placeholder="被签名对象路径，如 data" />
          </>
        )}
      </Space>
    </Line>
  );
}

export default function GatewayMappingEditor({ initial, methods, endpoint, onChange, onStatus, attempted = false, gatewayName, aiReady = false }: Props) {
  const [boot] = useState(() => {
    const result = fromMapping(initial, methods);
    return {
      state: result.state,
      issues: result.issues,
      json: JSON.stringify(toMapping(result.state), null, 2),
    };
  });
  const [state, setState] = useState<MappingFormState>(boot.state);
  const [issues, setIssues] = useState<string[]>(boot.issues);
  const [jsonText, setJsonText] = useState(boot.json);
  const [jsonDirty, setJsonDirty] = useState(false);

  const checks = useMemo(() => requiredChecks(state), [state]);
  const missing = checks.filter((c) => !c.ok);
  const missingKeys = useMemo(() => new Set(missing.map((c) => c.key)), [missing]);
  const [aiOpen, setAiOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [importErrors, setImportErrors] = useState<string[]>([]);
  const [importTemplates, setImportTemplates] = useState<PaymentTemplate[]>([]);
  const [importPick, setImportPick] = useState("");
  const [templatePick, setTemplatePick] = useState("");
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [openSections, setOpenSections] = useState<string[]>(["create"]);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [aiDoc, setAiDoc] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiDraft, setAiDraft] = useState<GatewayAiDraft | null>(null);
  const [aiErrors, setAiErrors] = useState<string[]>([]);
  const [aiApplied, setAiApplied] = useState(false);

  useEffect(() => {
    if (attempted) setOpenSections(["create"]);
  }, [attempted]);

  useEffect(() => {
    if (!attempted) return;
    const timer = window.setTimeout(() => {
      const first = rootRef.current?.querySelector(".mapping-field-error");
      first?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 60);
    return () => window.clearTimeout(timer);
  }, [attempted, openSections]);

  // 挂载时把初始状态交给父级（新切到 generic / 编辑已有映射都要）
  useEffect(() => {
    onStatus({ ready: missing.length === 0 && !jsonDirty, missing: missing.length, jsonDirty, warnings });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const description = useMemo(() => describeMapping(state), [state]);
  const warnings = [...issues, ...description.warnings];

  /** AI 草稿的只读预览：走与「导入模板」同一条 fromMapping，不另造格式 */
  const aiPreview = useMemo(() => {
    if (!aiDraft?.template) return null;
    const parsed = fromMapping(aiDraft.template.mapping, methods);
    return { issues: parsed.issues, description: describeMapping(parsed.state) };
  }, [aiDraft, methods]);
  const createMissing = missing.filter((c) => c.key.startsWith("create.") || c.key.startsWith("fields.") || c.key.startsWith("response.") || c.key === "sign").length;
  const callbackMissing = missing.filter((c) => c.key.startsWith("notify.")).length;
  const queryMissing = missing.filter((c) => c.key.startsWith("query.")).length;

  function emit(next: MappingFormState, dirty: boolean): void {
    onChange(toMapping(next));
    const rest = requiredChecks(next).filter((c) => !c.ok);
    onStatus({ ready: rest.length === 0 && !dirty, missing: rest.length, jsonDirty: dirty, warnings });
  }

  function patch(updater: (draft: MappingFormState) => void): void {
    const next = clone(state);
    updater(next);
    setState(next);
    emit(next, jsonDirty);
  }

  function applyTemplate(mapping: GatewayMappingLike, label: string): void {
    const result = fromMapping(mapping, methods);
    setState(result.state);
    setIssues(result.issues);
    setJsonText(JSON.stringify(toMapping(result.state), null, 2));
    setJsonDirty(false);
    emit(result.state, false);
    message.success(`已应用模板：${label}（未保存）`);
  }

  async function generateAiDraft(): Promise<void> {
    const document = aiDoc.trim();
    if (document.length < 200) {
      message.warning("接口文档至少 200 字");
      return;
    }
    setAiBusy(true);
    setAiErrors([]);
    setAiDraft(null);
    setAiApplied(false);
    try {
      const res = await api.gatewayAiDraft(document);
      setAiDraft(res.draft);
      if (res.draft.classification !== "generic_mapping") {
        message.warning("这份文档需要代码驱动或信息不足，AI 没有生成映射");
      }
    } catch (e) {
      const detail = e instanceof ApiError
        ? ((e.body?.details as { errors?: unknown } | undefined)?.errors)
        : undefined;
      setAiErrors(
        Array.isArray(detail) && detail.length
          ? detail.map((x) => String(x))
          : [e instanceof ApiError ? e.message || e.code : "生成失败"],
      );
    } finally {
      setAiBusy(false);
    }
  }

  function applyAiDraft(): void {
    if (!aiDraft?.template) return;
    if (!window.confirm(`应用 AI 草稿「${aiDraft.template.name}」到当前接口配置？应用后仍可修改，点保存才入库。`)) {
      return;
    }
    applyTemplate(aiDraft.template.mapping, `AI 草稿：${aiDraft.template.name}`);
    setAiApplied(true);
  }

  const [exportOpen, setExportOpen] = useState(false);
  const [exportName, setExportName] = useState("");
  const [exportId, setExportId] = useState("");
  const [exportFile, setExportFile] = useState("");
  const [exportDesc, setExportDesc] = useState("");

  function slugify(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "payment-template";
  }

  function openExport(): void {
    const name = gatewayName || "支付接口模板";
    const id = slugify(name);
    setExportName(name);
    setExportId(id);
    setExportFile(`${id}.json`);
    setExportDesc("");
    setExportOpen(true);
  }

  function downloadTemplate(): void {
    const name = exportName.trim();
    const id = exportId.trim();
    if (!name) { message.error("请填写模板名称"); return; }
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) {
      message.error("模板 ID 必须是小写字母/数字/连字符");
      return;
    }
    const rawFile = (exportFile.trim() || `${id}.json`).replace(/[\\/:*?"<>|]+/g, "-");
    const fileName = rawFile.toLowerCase().endsWith(".json") ? rawFile : `${rawFile}.json`;
    const template = {
      schema_version: 2,
      id,
      name,
      description: exportDesc.trim() || `从网关「${gatewayName || name}」导出`,
      source: "imported",
      mapping: toMapping(state),
    };
    const blob = new Blob([JSON.stringify(template, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(url);
    setExportOpen(false);
    message.success(`已导出 ${fileName}`);
  }

  function templateById(id: string): PaymentTemplate | undefined {
    return [...OFFICIAL_TEMPLATES, ...importTemplates].find((t) => t.id === id);
  }

  function useTemplate(id: string): void {
    const t = templateById(id);
    if (!t) return;
    if (!window.confirm(`用「${t.name}」覆盖当前接口配置？应用后仍可修改，点保存才入库。`)) return;
    applyTemplate(t.mapping, t.name);
    setTemplatePick(t.id);
    setImportOpen(false);
  }

  function parseImport(): void {
    const { templates, errors } = parseTemplateText(importText);
    setImportErrors(errors);
    setImportTemplates(templates);
    setImportPick(templates[0]?.id ?? "");
    if (!errors.length && templates.length) message.success(`识别到 ${templates.length} 个模板`);
  }

  async function readImportFile(file: File): Promise<void> {
    if (file.size > 64 * 1024) {
      setImportErrors(["模板文件不能超过 64KB"]);
      return;
    }
    setImportText(await file.text());
    setImportOpen(true);
  }

  function refreshJson(): void {
    setJsonText(JSON.stringify(toMapping(state), null, 2));
    setJsonDirty(false);
    onStatus({ ready: missing.length === 0, missing: missing.length, jsonDirty: false, warnings });
  }

  function applyJson(): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText) as unknown;
    } catch {
      message.error("JSON 不是合法的对象");
      return;
    }
    const result = fromMapping(parsed, methods);
    setState(result.state);
    setIssues(result.issues);
    setJsonText(JSON.stringify(toMapping(result.state), null, 2));
    setJsonDirty(false);
    emit(result.state, false);
    message.success("已应用到表单");
  }

  /**
   * 状态提示放在 Tabs **外面**：高级 JSON 里「应用」了未知键/缺必填时，
   * 用户在 JSON 页也要立刻看见，而不是切回表单才发现。
   */
  const createLabel = <>① 下单 {createMissing > 0 && <Badge count={createMissing} size="small" />}</>;
  const callbackLabel = <>② 回调 {callbackMissing > 0 && <Badge count={callbackMissing} size="small" />}</>;
  const queryLabel = <>③ 查单 {queryMissing > 0 && <Badge count={queryMissing} size="small" />}</>;

  const paramHeader = (
    <div style={{ display: "grid", gridTemplateColumns: "140px 1fr 240px", gap: 8, padding: "6px 0", borderBottom: "1px solid #f0f0f0", fontSize: 12, color: "#999" }}>
      <div>用途</div>
      <div>厂商字段名</div>
      <div>值 / 属性</div>
    </div>
  );

  const formTab = (
    <Tabs
      activeKey={openSections[0] ?? "create"}
      onChange={(key) => setOpenSections([key])}
      items={[
        {
          key: "create",
          label: createLabel,
          children: (
            <>
              <Section title="请求">
                <SubTitle>接口</SubTitle>
                <Line label="请求方式">
                  <Radio.Group
                    value={state.create.method}
                    onChange={(e) => patch((d) => void (d.create.method = e.target.value))}
                    options={[{ value: "POST", label: "POST" }, { value: "GET", label: "GET" }]}
                  />
                </Line>
                <Line
                  label="接口路径"
                  required
                  hint="只填路径；域名在「网关地址」里，例如 /mapi.php"
                  error={attempted && missingKeys.has("create.path") ? "请填写下单接口路径" : undefined}
                >
                  <Input value={state.create.path} onChange={(e) => patch((d) => void (d.create.path = e.target.value))} placeholder="/mapi.php" />
                </Line>
                <Line label="请求体" required>
                  <Radio.Group
                    value={state.create.format}
                    onChange={(e) => patch((d) => void (d.create.format = e.target.value))}
                    options={[
                      { value: "form", label: "表单（x-www-form-urlencoded）" },
                      { value: "json", label: "JSON" },
                    ]}
                  />
                </Line>

                <SubTitle>参数</SubTitle>
                {paramHeader}
                {FIELD_ROWS.map((row) => {
                  const fieldName = state.fields[row.key];
                  const error = attempted && missingKeys.has(`fields.${row.key}`) ? "必填" : undefined;
                  return (
                    <div
                      key={row.key}
                      style={{ display: "grid", gridTemplateColumns: "140px 1fr 240px", gap: 8, padding: "8px 0", borderBottom: "1px solid #f7f7f7", alignItems: "start" }}
                    >
                      <div style={{ paddingTop: 5 }}>
                        {row.label}
                        {row.required ? <span style={{ color: "#ff4d4f" }}> *</span> : null}
                      </div>
                      <div>
                        <Input
                          value={fieldName}
                          status={error ? "error" : undefined}
                          onChange={(e) => patch((d) => void (d.fields[row.key] = e.target.value))}
                          placeholder={row.key === "merchant" ? "pid / mchId / appid" : ""}
                        />
                        <div style={{ marginTop: 2, fontSize: 12, color: error ? "#ff4d4f" : "#999" }}>
                          {error ?? row.hint ?? ""}
                        </div>
                      </div>
                      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                        {row.key === "amount" && (
                          <Select
                            value={state.amount_unit}
                            onChange={(v) => patch((d) => void (d.amount_unit = v))}
                            options={[{ value: "yuan", label: "元" }, { value: "cent", label: "分" }]}
                            style={{ width: 90 }}
                          />
                        )}
                        {row.key === "timestamp" && (
                          <Select
                            value={state.timestamp_format}
                            onChange={(v) => patch((d) => void (d.timestamp_format = v))}
                            options={[
                              { value: "s", label: "秒" },
                              { value: "ms", label: "毫秒" },
                              { value: "ymdhms", label: "ymdhms" },
                            ]}
                            style={{ width: 110 }}
                          />
                        )}
                        <Checkbox
                          checked={!!fieldName && state.numeric_fields.includes(fieldName)}
                          disabled={!fieldName}
                          onChange={(checked) =>
                            patch((d) => {
                              d.numeric_fields = checked
                                ? [...d.numeric_fields.filter((x) => x !== fieldName), fieldName]
                                : d.numeric_fields.filter((x) => x !== fieldName);
                            })
                          }
                        >
                          JSON 数字
                        </Checkbox>
                      </div>
                    </div>
                  );
                })}

                <SubTitle>固定参数</SubTitle>
                <KvEditor rows={state.constants} onChange={(rows) => patch((d) => void (d.constants = rows))} allowType hint="每次请求都带的常量，如 sign_type=MD5" />
                <SubTitle>认证</SubTitle>
                <AuthEditor value={state.auth} onChange={(v) => patch((d) => void (d.auth = v))} />
                <SubTitle>签名</SubTitle>
                <SignEditor title="下单签名" value={state.sign} onChange={(v) => patch((d) => void (d.sign = v))} />
              </Section>

              <Section title="响应">
                <Line label="成功判定" required hint="例如 code = 1、errcode = 0、code ∈ {0, 200}" error={attempted && missingKeys.has("response.ok") ? "请填写成功判定" : undefined}>
                  <WhenEditor value={state.response.ok} onChange={(v) => patch((d) => void (d.response.ok = v))} />
                </Line>
                <Line label="收银台字段" required hint="只填一个响应路径；该路径必须返回可直接打开的页面 URL（不支持二维码内容或 App scheme）" error={attempted && missingKeys.has("response.pay_url") ? "请填写收银台字段" : undefined}>
                  <Input value={state.response.pay_url} onChange={(e) => patch((d) => void (d.response.pay_url = e.target.value))} placeholder="payurl / data.payUrl / data.uri" />
                </Line>
                <Line label="错误信息字段">
                  <Input value={state.response.message} onChange={(e) => patch((d) => void (d.response.message = e.target.value))} placeholder="msg / message / error" />
                </Line>
                <Line label="服务商流水号字段">
                  <Input value={state.response.trade_no} onChange={(e) => patch((d) => void (d.response.trade_no = e.target.value))} placeholder="trade_no / data.tradeNo" />
                </Line>
                <Line label="收银台过期时间字段">
                  <Input value={state.response.expires_at} onChange={(e) => patch((d) => void (d.response.expires_at = e.target.value))} placeholder="expires_at / data.expireTime" />
                </Line>
                <ResponseSignEditor title="响应验签" value={state.response.sign} onChange={(v) => patch((d) => void (d.response.sign = v))} />
              </Section>
            </>
          ),
        },
        {
          key: "callback",
          label: callbackLabel,
          children: (
            <>
              <Section title="请求">
                <SubTitle>接口</SubTitle>
                <Line label="请求方式">
                  <Radio.Group
                    value={state.notify.method}
                    onChange={(e) => patch((d) => void (d.notify.method = e.target.value))}
                    options={[{ value: "POST", label: "POST" }, { value: "GET", label: "GET" }]}
                  />
                </Line>
                <Line label="请求体">
                  <Radio.Group
                    value={state.notify.format}
                    disabled={state.notify.method === "GET"}
                    onChange={(e) => patch((d) => void (d.notify.format = e.target.value))}
                    options={[{ value: "form", label: "表单" }, { value: "json", label: "JSON" }]}
                  />
                </Line>
                <SubTitle>参数</SubTitle>
                <Line label="订单号字段" required error={attempted && missingKeys.has("notify.order_no") ? "请填写回调订单号字段" : undefined}>
                  <Space direction="vertical" size={6} style={{ width: "100%" }}>
                    <Radio.Group
                      value={state.notify.order_no_mode}
                      onChange={(e) => patch((d) => void (d.notify.order_no_mode = e.target.value))}
                      options={[{ value: "follow", label: "与下单相同" }, { value: "custom", label: "自定义" }]}
                    />
                    {state.notify.order_no_mode === "custom" && (
                      <Input value={state.notify.order_no} onChange={(e) => patch((d) => void (d.notify.order_no = e.target.value))} placeholder="out_trade_no" />
                    )}
                  </Space>
                </Line>
                <Line label="金额字段">
                  <Space direction="vertical" size={6} style={{ width: "100%" }}>
                    <Space wrap>
                      <Radio.Group
                        value={state.notify.amount_mode}
                        onChange={(e) => patch((d) => void (d.notify.amount_mode = e.target.value))}
                        options={[
                          { value: "follow", label: "与下单相同" },
                          { value: "custom", label: "自定义" },
                          { value: "none", label: "不核对金额" },
                        ]}
                      />
                      <Select
                        value={state.notify_amount_unit}
                        onChange={(v) => patch((d) => void (d.notify_amount_unit = v))}
                        options={[{ value: "follow", label: "跟随下单" }, { value: "yuan", label: "元" }, { value: "cent", label: "分" }]}
                        style={{ width: 120 }}
                      />
                    </Space>
                    {state.notify.amount_mode === "custom" && (
                      <Input value={state.notify.amount} onChange={(e) => patch((d) => void (d.notify.amount = e.target.value))} placeholder="amount" />
                    )}
                  </Space>
                </Line>
                <Line label="服务商流水号字段">
                  <Input value={state.notify.trade_no} onChange={(e) => patch((d) => void (d.notify.trade_no = e.target.value))} placeholder="trade_no / transaction_id" />
                </Line>
                <Line label="已付判定" required error={attempted && missingKeys.has("notify.paid_when") ? "请填写已付判定" : undefined}>
                  <WhenEditor value={state.notify.paid_when} onChange={(v) => patch((d) => void (d.notify.paid_when = v))} />
                </Line>
                <SubTitle>签名</SubTitle>
                <SignEditor title="回调验签" value={state.notify_sign} onChange={(v) => patch((d) => void (d.notify_sign = v))} />
              </Section>
              <Section title="响应">
                <Line label="应答原文" required hint="必须与厂商要求逐字一致，写错会被无限重发" error={attempted && missingKeys.has("notify.reply") ? "请填写应答原文" : undefined}>
                  <Input value={state.notify.reply} onChange={(e) => patch((d) => void (d.notify.reply = e.target.value))} placeholder="success / SUCCESS / OK" />
                </Line>
              </Section>
            </>
          ),
        },
        {
          key: "query",
          label: queryLabel,
          children: (
            <>
              <Section title="请求">
                <SubTitle>接口</SubTitle>
                <Line label="请求方式">
                  <Radio.Group
                    value={state.query.method}
                    onChange={(e) => patch((d) => void (d.query.method = e.target.value))}
                    options={[{ value: "POST", label: "POST" }, { value: "GET", label: "GET" }]}
                  />
                </Line>
                <Line label="接口路径" required error={attempted && missingKeys.has("query.path") ? "请填写查单接口路径" : undefined}>
                  <Input value={state.query.path} onChange={(e) => patch((d) => void (d.query.path = e.target.value))} placeholder="/api.php 或 /pay/query" />
                </Line>
                <Line label="请求体">
                  <Radio.Group
                    value={state.query.format}
                    disabled={state.query.method === "GET"}
                    onChange={(e) => patch((d) => void (d.query.format = e.target.value))}
                    options={[{ value: "form", label: "表单" }, { value: "json", label: "JSON" }]}
                  />
                </Line>
                <SubTitle>参数</SubTitle>
                <KvEditor
                  rows={state.query.fields}
                  onChange={(rows) => patch((d) => void (d.query.fields = rows))}
                  keyPlaceholder="参数名"
                  valuePlaceholder="值，如 {order_no}"
                  allowType
                  hint="值可写 {merchant} {secret} {order_no} {amount} {channel} {timestamp} {nonce}；类型列选择数字即 JSON 数字"
                />
                <Line label="时间戳格式">
                  <Select
                    value={state.query_timestamp_format}
                    onChange={(v) => patch((d) => void (d.query_timestamp_format = v))}
                    options={[{ value: "s", label: "秒" }, { value: "ms", label: "毫秒" }, { value: "ymdhms", label: "ymdhms" }]}
                    style={{ width: 160 }}
                  />
                </Line>
                <SubTitle>认证</SubTitle>
                <AuthEditor value={state.query_auth} onChange={(v) => patch((d) => void (d.query_auth = v))} />
                <SubTitle>固定参数</SubTitle>
                <KvEditor rows={state.query_constants} onChange={(rows) => patch((d) => void (d.query_constants = rows))} allowType hint="只影响查单请求" />
                <SubTitle>签名</SubTitle>
                <SignEditor title="查单签名" value={state.query_sign} onChange={(v) => patch((d) => void (d.query_sign = v))} />
              </Section>

              <Section title="响应">
                <Line label="成功判定" hint="不填 = 不判断接口级成功">
                  <WhenEditor value={state.query.ok} onChange={(v) => patch((d) => void (d.query.ok = v))} />
                </Line>
                <Line label="已付判定" required error={attempted && missingKeys.has("query.paid_when") ? "请填写查单已付判定" : undefined}>
                  <WhenEditor value={state.query.paid_when} onChange={(v) => patch((d) => void (d.query.paid_when = v))} />
                </Line>
                <Line label="明确终态" hint="失败/过期/撤销：命中后不再重试（可选）">
                  <WhenEditor value={state.query.terminal_when} onChange={(v) => patch((d) => void (d.query.terminal_when = v))} />
                </Line>
                <SubTitle>数据</SubTitle>
                <Line label="金额字段">
                  <Space.Compact style={{ width: "100%" }}>
                    <Input value={state.query.amount} onChange={(e) => patch((d) => void (d.query.amount = e.target.value))} placeholder="data.amount" style={{ flex: 1 }} />
                    <Select
                      value={state.query_amount_unit}
                      onChange={(v) => patch((d) => void (d.query_amount_unit = v))}
                      options={[{ value: "follow", label: "跟随下单" }, { value: "yuan", label: "元" }, { value: "cent", label: "分" }]}
                      style={{ width: 120 }}
                    />
                  </Space.Compact>
                </Line>
                <Line label="流水号字段">
                  <Input value={state.query.trade_no} onChange={(e) => patch((d) => void (d.query.trade_no = e.target.value))} placeholder="data.tradeNo" />
                </Line>
                <Line label="错误信息字段">
                  <Input value={state.query.message} onChange={(e) => patch((d) => void (d.query.message = e.target.value))} placeholder="msg / message" />
                </Line>
                <ResponseSignEditor title="响应验签" value={state.query_response_sign} onChange={(v) => patch((d) => void (d.query_response_sign = v))} />
              </Section>
            </>
          ),
        },
      ]}
    />
  );

  return (
    <div className="mapping-editor" ref={rootRef}>
      <Space wrap style={{ marginBottom: 12 }}>
        <Select
          placeholder="从模板开始"
          style={{ width: 220 }}
          value={templatePick || undefined}
          onChange={(id: string) => useTemplate(id)}
          options={[
            ...OFFICIAL_TEMPLATES.map((t) => ({ value: t.id, label: t.name })),
            ...importTemplates.map((t) => ({ value: t.id, label: `${t.name}（导入）` })),
          ]}
        />
        <Button onClick={() => setImportOpen((v) => !v)}>导入模板</Button>
        <Button onClick={openExport}>导出模板</Button>
        <Button type="link" size="small" onClick={() => setAiOpen((v) => !v)} style={{ paddingInline: 0 }}>
          AI 配置助手（{aiOpen ? "收起" : "展开"}）
        </Button>
      </Space>
      {importOpen && (
        <div className="card" style={{ marginBottom: 12, padding: 12 }}>
          <Space direction="vertical" size={8} style={{ width: "100%" }}>
            <Typography.Text type="secondary">
              导入 JSON 模板（只含接口类型；地址/商户/凭据/通道号请在基本信息填写）。不会自动保存。
            </Typography.Text>
            <input
              ref={fileRef}
              type="file"
              accept=".json,application/json"
              style={{ display: "none" }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void readImportFile(f);
                e.target.value = "";
              }}
            />
            <Space>
              <Button size="small" onClick={() => fileRef.current?.click()}>选择文件</Button>
              <Button size="small" onClick={parseImport} disabled={!importText.trim()}>解析粘贴内容</Button>
            </Space>
            <Input.TextArea
              rows={6}
              className="mono"
              placeholder='{"schema_version":2,"template":{"id":"...","name":"...","mapping":{...}}}'
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
            />
            {importErrors.map((err) => (
              <Alert key={err} type="error" showIcon message={err} />
            ))}
            {importTemplates.length > 0 && (
              <>
                <Select
                  value={importPick}
                  onChange={setImportPick}
                  style={{ width: "100%" }}
                  options={importTemplates.map((t) => ({ value: t.id, label: `${t.name}（导入 / 未审核）` }))}
                />
                {(() => {
                  const t = importTemplates.find((x) => x.id === importPick);
                  if (!t) return null;
                  const parsed = fromMapping(t.mapping, methods);
                  const issues = parsed.issues;
                  return (
                    <>
                      <Alert type="warning" showIcon message="第三方/导入模板，未审核；应用后请人工核对并测试支付" />
                      {issues.map((x) => <Alert key={x} type="warning" showIcon message={x} />)}
                      <Button type="primary" onClick={() => useTemplate(t.id)}>应用这个模板</Button>
                    </>
                  );
                })()}
              </>
            )}
          </Space>
        </div>
      )}
      <div style={{ marginBottom: 12 }}>
        {aiOpen && (
          <div className="card" style={{ padding: 12 }}>
            <Space direction="vertical" size={8} style={{ width: "100%" }}>
              <Typography.Text type="secondary">
                粘贴厂商接口文档（三端点、签名、金额单位、状态码）。只生成协议类型，不含网关地址/商户号/密钥/通道号；
                不会自动保存或发布。
              </Typography.Text>
              {!aiReady && (
                <Alert
                  type="warning"
                  showIcon
                  message="AI 配置助手未配置"
                  description="服务端需要同时设置 AI_API_KEY、AI_MODEL、AI_BASE_URL 才会开放；现在仍可用模板导入。"
                />
              )}
              <Input.TextArea
                rows={8}
                className="mono"
                value={aiDoc}
                disabled={!aiReady || aiBusy}
                onChange={(e) => setAiDoc(e.target.value)}
                placeholder="粘贴厂商接口文档正文（下单 / 回调 / 查单、签名、金额单位、状态码）"
              />
              <Space align="center">
                <Button
                  type="primary"
                  loading={aiBusy}
                  disabled={!aiReady || aiDoc.trim().length < 200}
                  onClick={() => void generateAiDraft()}
                >
                  生成草稿
                </Button>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {[...aiDoc.trim()].length} 字（至少 200；上限 60KB）
                </Typography.Text>
              </Space>
              {aiErrors.map((err, i) => <Alert key={i} type="error" showIcon message={err} />)}
              {aiApplied && (
                <Alert
                  type="warning"
                  showIcon
                  message="已应用到表单（未保存）"
                  description="AI 草稿不等于测试通过：保存后仍要完成「创建 + 查单」测试；开启回调验证时还要真实回调才能发布。"
                />
              )}
              {aiDraft && (
                <>
                  <Space wrap>
                    <Tag color={aiDraft.classification === "generic_mapping" ? "green" : "orange"}>
                      {aiDraft.classification}
                    </Tag>
                    {aiDraft.template && <Typography.Text strong>{aiDraft.template.name}</Typography.Text>}
                    {aiDraft.template && <Typography.Text type="secondary" code>{aiDraft.template.id}</Typography.Text>}
                  </Space>
                  {aiDraft.template ? (
                    <>
                      <Alert type="info" showIcon message="AI 草稿，未审核；应用后请人工核对并测试支付" />
                      {aiPreview && (
                        <div>
                          <Typography.Text strong>预览</Typography.Text>
                          <div style={{ marginTop: 4 }}>
                            {aiPreview.description.rows.map((row) => (
                              <div
                                key={row.label}
                                style={{ display: "grid", gridTemplateColumns: "110px 1fr", gap: 8, fontSize: 12, padding: "3px 0", borderBottom: "1px solid #f7f7f7" }}
                              >
                                <span style={{ color: "#999" }}>{row.label}</span>
                                <span>{row.value}</span>
                              </div>
                            ))}
                          </div>
                          {aiPreview.issues.map((x, i) => <Alert key={`i${i}`} type="warning" showIcon message={x} />)}
                          {aiPreview.description.warnings.map((x, i) => <Alert key={`w${i}`} type="warning" showIcon message={x} />)}
                        </div>
                      )}
                      <Space>
                        <Button type="primary" onClick={applyAiDraft}>应用到表单</Button>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>应用 ≠ 保存；保存后仍需重新测试。</Typography.Text>
                      </Space>
                    </>
                  ) : (
                    <Alert
                      type="warning"
                      showIcon
                      message={`classification = ${aiDraft.classification}`}
                      description={
                        aiDraft.classification === "driver"
                          ? "这份协议需要代码驱动（RSA 双向签名 / OAuth / 远程验签等），不能只靠映射配置。"
                          : "文档缺少查单或三端点不全，无法生成通用映射。"
                      }
                    />
                  )}
                  {aiDraft.evidence.length > 0 && (
                    <div>
                      <Typography.Text strong>依据</Typography.Text>
                      <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
                        {aiDraft.evidence.map((e, i) => (
                          <li key={i}>
                            <Typography.Text type="secondary">{e.section}：</Typography.Text>
                            {e.quote}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {aiDraft.uncertainty.length > 0 && (
                    <div>
                      <Typography.Text strong>不确定点</Typography.Text>
                      <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
                        {aiDraft.uncertainty.map((u, i) => <li key={i}>{u}</li>)}
                      </ul>
                    </div>
                  )}
                </>
              )}
            </Space>
          </div>
        )}
      </div>
      {formTab}
      {endpoint ? (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          网关地址：{endpoint}
        </Typography.Text>
      ) : null}
      <Modal
        open={exportOpen}
        title="导出接口模板"
        okText="下载文件"
        cancelText="取消"
        onOk={downloadTemplate}
        onCancel={() => setExportOpen(false)}
      >
        <Space direction="vertical" size={10} style={{ width: "100%" }}>
          <Typography.Text type="secondary">
            导出的是接口类型文件，不包含网关地址、商户号、密钥、支付方式或通道号。
          </Typography.Text>
          <Line label="模板名称" required>
            <Input value={exportName} onChange={(e) => setExportName(e.target.value)} placeholder="例如：泡泡支付" />
          </Line>
          <Line label="模板 ID" required hint="小写字母/数字/连字符；导入时用于识别">
            <Input value={exportId} onChange={(e) => setExportId(e.target.value)} placeholder="qwgua" />
          </Line>
          <Line label="文件名" required hint="默认 <模板ID>.json">
            <Input value={exportFile} onChange={(e) => setExportFile(e.target.value)} placeholder="qwgua.json" />
          </Line>
          <Line label="说明">
            <Input value={exportDesc} onChange={(e) => setExportDesc(e.target.value)} placeholder="可选" />
          </Line>
          <Alert
            type="info"
            showIcon
            message="标准流程：导出文件 → 支持人员修改 → 租户导入 → 预览 → 保存 → 测试支付"
          />
        </Space>
      </Modal>
    </div>
  );
}
