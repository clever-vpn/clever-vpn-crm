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
import { api, ApiError, type GatewayAiDraft, type GatewayAiGate } from "../api";
import { AI_DOC_MAX_BYTES, AI_DOC_MAX_FILES, mergeAiSubmission, readAiDocument } from "../ai-doc";
import { buildAiSupportReport } from "../ai-support";

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

interface AiDocFileItem {
  id: string;
  name: string;
  text: string;
  chars: number;
  source: "file" | "url";
  selected: boolean;
  /** URL 导入时保留来源，便于统一列表里区分 */
  url?: string;
  reason?: "entry" | "ai" | "keyword";
}

type AiFailureKind =
  | "input"
  | "invalid_draft"
  | "doc_incomplete"
  | "gateway"
  | "rate_limited"
  | "network";

interface AiFailure {
  kind: AiFailureKind;
  title: string;
  details: string[];
}

const AI_DOC_CHECKLIST = [
  "三个端点：创建订单、支付通知、查询订单（method / path / format）",
  "请求字段：商户号、订单号、金额（单位）、商品名、回调地址、渠道、时间戳/随机串（如有）",
  "签名：字段名、算法、排序/拼接规则、密钥位置、大小写",
  "判定：成功码、已付状态、查单终态、回调应答原文",
  "响应：收银台字段、平台订单号、金额、响应验签（如有）",
  "多页文档：下单、查单、通知、签名规则分别提交为附件；尽量带字段表和示例",
];

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
  const [pendingTemplate, setPendingTemplate] = useState<PaymentTemplate | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const aiFileRef = useRef<HTMLInputElement | null>(null);
  const [openSections, setOpenSections] = useState<string[]>(["create"]);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [aiDoc, setAiDoc] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const aiRequestRef = useRef(0);
  const [aiDraft, setAiDraft] = useState<GatewayAiDraft | null>(null);
  const [aiGate, setAiGate] = useState<GatewayAiGate | null>(null);
  const [aiApplied, setAiApplied] = useState(false);
  const [aiFiles, setAiFiles] = useState<AiDocFileItem[]>([]);
  const [aiFailure, setAiFailure] = useState<AiFailure | null>(null);
  const [aiMeta, setAiMeta] = useState<{ model: string; attempts: number } | null>(null);
  const [aiUrl, setAiUrl] = useState("");
  const [aiUrlOpen, setAiUrlOpen] = useState(false);
  const [aiUrlBusy, setAiUrlBusy] = useState(false);
  const [aiUrlError, setAiUrlError] = useState("");
  const [aiUrlWarnings, setAiUrlWarnings] = useState<string[]>([]);
  const [aiUrlAiUsed, setAiUrlAiUsed] = useState(false);

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
  /** 模板确认框里展示 issues，避免用户确认后才发现模板本身有问题 */
  const pendingTemplatePreview = useMemo(
    () => (pendingTemplate ? fromMapping(pendingTemplate.mapping, methods) : null),
    [pendingTemplate, methods],
  );

  /** 给用户看的 4 行摘要；完整字段/依据放到折叠区 */
  const aiSummary = useMemo(() => {
    const mapping = aiDraft?.template?.mapping;
    if (!mapping) return [];
    const amount = mapping.create.request.fields.find((f) => f.role === "amount");
    return [
      { label: "下单", value: `${mapping.create.request.method ?? "POST"} ${mapping.create.request.path}` },
      {
        label: "查单",
        value: mapping.query ? `${mapping.query.request.method ?? "POST"} ${mapping.query.request.path}` : "未配置",
      },
      { label: "回调应答", value: mapping.notify.response.reply },
      {
        label: "金额",
        value: amount ? `${amount.field}（${amount.unit === "cent" ? "分" : "元"}）` : "未配置",
      },
    ];
  }, [aiDraft]);
  /** 文本框=粘贴，文件和 URL 页面在同一个附件集合；只提交勾选项，都不写回 textarea */
  const aiSubmission = useMemo(
    () => mergeAiSubmission(aiDoc, aiFiles.filter((f) => f.selected)),
    [aiDoc, aiFiles],
  );
  const selectedAiFiles = aiFiles.filter((f) => f.selected);
  const urlPageCount = aiFiles.filter((f) => f.source === "url").length;
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

  function applyMapping(mapping: GatewayMappingLike): void {
    const result = fromMapping(mapping, methods);
    setState(result.state);
    setIssues(result.issues);
    setJsonText(JSON.stringify(toMapping(result.state), null, 2));
    setJsonDirty(false);
    emit(result.state, false);
  }

  function applyTemplate(mapping: GatewayMappingLike, label: string): void {
    applyMapping(mapping);
    message.success(`已应用模板：${label}（未保存）`);
  }

  function failureFromError(error: unknown): AiFailure {
    if (error instanceof ApiError) {
      const raw = (error.body?.details as { errors?: unknown } | undefined)?.errors;
      const details = Array.isArray(raw) ? raw.map((x) => String(x)) : [];
      const message = error.message || error.code;
      if (error.code === "invalid_draft") {
        return { kind: "invalid_draft", title: "AI 输出不合法，未生成配置", details: details.length ? details : [message] };
      }
      if (error.code === "document_too_short" || error.code === "document_too_large") {
        return { kind: "input", title: "提交文档不可用", details: details.length ? details : [message] };
      }
      if (error.code === "ai_rate_limited") {
        return { kind: "rate_limited", title: "生成次数超限", details: [message] };
      }
      if (error.code === "ai_unavailable" || error.code === "ai_upstream_error" || error.code === "ai_timeout") {
        return { kind: "gateway", title: "模型/网关暂时不可用", details: details.length ? details : [message] };
      }
      if (
        ["invalid_url", "blocked_host", "no_document", "unsupported_content", "document_too_large"].includes(error.code)
      ) {
        return { kind: "input", title: "文档网址不可用", details: details.length ? details : [message] };
      }
      if (error.code === "ai_fetch_rate_limited") {
        return { kind: "rate_limited", title: "抓取次数超限", details: [message] };
      }
      if (error.code === "doc_fetch_failed") {
        return { kind: "gateway", title: "抓取文档失败", details: [message] };
      }
      return { kind: "network", title: "生成失败", details: details.length ? details : [message] };
    }
    return {
      kind: "network",
      title: "生成失败",
      details: [error instanceof Error ? error.message : "网络或未知错误"],
    };
  }

  async function generateAiDraft(): Promise<void> {
    if (aiBusy) return;
    if (aiSubmission.error) {
      setAiFailure({ kind: "input", title: "提交正文不可用", details: [aiSubmission.error] });
      return;
    }
    const document = aiSubmission.document;
    if ([...document].length < 200) {
      message.warning("提交正文至少 200 字（粘贴 + 附件合计）");
      return;
    }
    const requestId = aiRequestRef.current + 1;
    aiRequestRef.current = requestId;
    setAiBusy(true);
    setAiDraft(null);
    setAiGate(null);
    setAiApplied(false);
    setAiFailure(null);
    setAiMeta(null);
    try {
      const res = await api.gatewayAiDraft(document);
      if (requestId !== aiRequestRef.current) return;
      setAiDraft(res.draft);
      setAiGate(res.gate);
      setAiMeta({ model: res.model, attempts: res.attempts ?? 1 });
      if (
        !res.draft.template ||
        res.draft.classification !== "generic_mapping" ||
        res.gate.status === "insufficient"
      ) {
        const details = res.gate.missing.length
          ? res.gate.missing
          : [
              res.draft.classification === "driver"
                ? "这份协议需要代码驱动（RSA 双向签名 / OAuth / 远程验签等），不能只靠映射配置。"
                : "文档缺少查单或三端点不全，无法生成通用映射。",
              ...res.draft.uncertainty.slice(0, 5),
            ];
        setAiFailure({ kind: "doc_incomplete", title: "文档不足，未生成配置", details });
        return;
      }
      applyMapping(res.draft.template.mapping);
      setTemplatePick("");
      setAiApplied(true);
      message.success("配置生成成功，已填入表单（未保存）");
    } catch (error) {
      setAiFailure(failureFromError(error));
    } finally {
      setAiBusy(false);
    }
  }

  function resetAiResult(): void {
    aiRequestRef.current += 1;
    setAiBusy(false);
    setAiDraft(null);
    setAiGate(null);
    setAiApplied(false);
    setAiFailure(null);
    setAiMeta(null);
  }

  /** 文件与 URL 页面共用这一个集合；总数/100KB 在这里统一把关 */
  function addAiItems(items: AiDocFileItem[]): { ok: boolean; error?: string; added: number; chars: number } {
    const existing = new Set(aiFiles.map((f) => f.id));
    const fresh = items.filter((f) => !existing.has(f.id));
    if (fresh.length === 0) return { ok: true, added: 0, chars: 0 };
    const next = [...aiFiles, ...fresh];
    if (next.length > AI_DOC_MAX_FILES) {
      return {
        ok: false,
        error: `文件/页面最多 ${AI_DOC_MAX_FILES} 个；请先移除一些再导入`,
        added: 0,
        chars: 0,
      };
    }
    const merged = mergeAiSubmission(aiDoc, next.filter((f) => f.selected));
    if (merged.error) return { ok: false, error: merged.error, added: 0, chars: 0 };
    setAiFiles(next);
    resetAiResult();
    return { ok: true, added: fresh.length, chars: merged.fileChars };
  }

  async function fetchAiDocFromUrl(): Promise<void> {
    const url = aiUrl.trim();
    if (!url) {
      setAiUrlError("请先填文档入口 URL");
      return;
    }
    setAiUrlBusy(true);
    setAiUrlError("");
    try {
      const res = await api.fetchAiDoc(url);
      const items: AiDocFileItem[] = res.pages.map((p) => ({
        id: `url:${p.url}`,
        name: p.title || p.url,
        text: p.text,
        chars: p.chars,
        source: "url",
        selected: true,
        url: p.url,
        reason: p.reason,
      }));
      const added = addAiItems(items);
      if (!added.ok) {
        setAiUrlError(added.error ?? "URL 页面导入失败");
        return;
      }
      setAiUrlWarnings(res.warnings);
      setAiUrlAiUsed(res.ai_used);
      setAiUrlOpen(false);
      setAiUrlError("");
      if (added.added === 0) message.info("这些页面已经导入过了");
      else message.success(`已从 URL 导入 ${added.added} 页（${res.ai_used ? "AI 选页" : "关键词选页"}）`);
    } catch (error) {
      const failure = failureFromError(error);
      setAiUrlError([failure.title, ...failure.details].join("；"));
    } finally {
      setAiUrlBusy(false);
    }
  }

  function toggleAiItem(id: string): void {
    setAiFiles((prev) => prev.map((f) => (f.id === id ? { ...f, selected: !f.selected } : f)));
    resetAiResult();
  }

  function removeAiFile(id: string): void {
    setAiFiles((prev) => prev.filter((f) => f.id !== id));
    resetAiResult();
  }

  async function copyAiSupport(): Promise<void> {
    const report = buildAiSupportReport({
      at: new Date().toISOString(),
      gatewayName,
      model: aiMeta?.model,
      attempts: aiMeta?.attempts,
      classification: aiDraft?.classification,
      templateName: aiDraft?.template?.name,
      templateId: aiDraft?.template?.id,
      gate: aiGate,
      summary: aiSummary,
      evidence: aiDraft?.evidence ?? [],
      uncertainty: aiDraft?.uncertainty ?? [],
      input: {
        pasteChars: aiSubmission.pasteChars,
        fileChars: aiSubmission.fileChars,
        files: aiFiles.map((f) => ({ name: f.name, source: f.source, url: f.url })),
      },
      failure: aiFailure ? { title: aiFailure.title, details: aiFailure.details } : null,
    });
    try {
      await navigator.clipboard.writeText(report);
      message.success("已复制诊断信息；发送前请确认不含商户密钥");
    } catch {
      message.error("复制失败，请检查浏览器剪贴板权限");
    }
  }

  function scrollToForm(): void {
    setOpenSections(["create"]);
    window.setTimeout(() => {
      rootRef.current?.querySelector(".ant-tabs")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 50);
  }

  async function readAiFiles(files: File[]): Promise<void> {
    if (files.length === 0) return;
    const existing = new Set(aiFiles.map((f) => f.id));
    const batch: File[] = [];
    const batchIds = new Set<string>();
    for (const file of files) {
      const id = `${file.name}:${file.size}:${file.lastModified}`;
      if (existing.has(id) || batchIds.has(id)) continue;
      batchIds.add(id);
      batch.push(file);
    }
    if (batch.length === 0) {
      message.info("这些文件已经导入过了");
      return;
    }

    const items: AiDocFileItem[] = [];
    const errors: string[] = [];
    for (const file of batch) {
      const raw = await file.text();
      const result = readAiDocument(file.name, raw);
      if (result.error) errors.push(`${file.name}：${result.error}`);
      else {
        items.push({
          id: `${file.name}:${file.size}:${file.lastModified}`,
          name: file.name,
          text: result.text,
          chars: [...result.text].length,
          source: "file",
          selected: true,
        });
      }
    }
    if (errors.length > 0) {
      setAiFailure({ kind: "input", title: "文件导入失败", details: errors });
      return;
    }
    const added = addAiItems(items);
    if (!added.ok) {
      setAiFailure({ kind: "input", title: "文件导入失败", details: [added.error ?? "合并失败"] });
      return;
    }
    message.success(`已导入 ${added.added} 个文件（已选 ${added.chars} 字）`);
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

  function requestTemplate(id: string): void {
    const t = templateById(id);
    if (!t) return;
    setPendingTemplate(t);
  }

  function applyPendingTemplate(): void {
    const t = pendingTemplate;
    if (!t) return;
    applyTemplate(t.mapping, t.name);
    setTemplatePick(t.id);
    setPendingTemplate(null);
    setImportOpen(false);
    setAiOpen(false);
    resetAiResult();
  }

  function openImportPanel(): void {
    const next = !importOpen;
    setImportOpen(next);
    if (next) {
      setAiOpen(false);
      setTemplatePick("");
      resetAiResult();
    }
  }

  function toggleAiPanel(): void {
    const next = !aiOpen;
    setAiOpen(next);
    if (next) {
      setImportOpen(false);
      setTemplatePick("");
      resetAiResult();
    }
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
    setAiOpen(false);
    resetAiResult();
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
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: 12,
          flexWrap: "wrap",
          marginBottom: 12,
        }}
      >
        <Space wrap>
          <Select
            placeholder="从模板开始"
            style={{ width: 220 }}
            value={templatePick || undefined}
            onChange={(id: string) => requestTemplate(id)}
            options={[
              ...OFFICIAL_TEMPLATES.map((t) => ({ value: t.id, label: t.name })),
              ...importTemplates.map((t) => ({ value: t.id, label: `${t.name}（导入）` })),
            ]}
          />
          <Button onClick={openImportPanel}>导入模板</Button>
          <Button type={aiOpen ? "primary" : "default"} aria-pressed={aiOpen} onClick={toggleAiPanel}>
            AI 配置助手
          </Button>
        </Space>
        <Button onClick={openExport}>导出模板</Button>
      </div>
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
                      <Button type="primary" onClick={() => requestTemplate(t.id)}>应用这个模板</Button>
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
                粘贴或导入厂商接口文档（三端点、签名、金额单位、状态码）。只生成协议类型，不含网关地址/商户号/密钥/通道号；
                不会自动保存或发布。
              </Typography.Text>
              {!aiReady && (
                <Alert
                  type="warning"
                  showIcon
                  message="AI 配置助手未配置"
                  description="服务端需要 AI binding 与 CLOUDFLARE_GATEWAY_ID（AI Gateway）才会开放；现在仍可用模板导入。"
                />
              )}
              <input
                ref={aiFileRef}
                type="file"
                multiple
                accept=".txt,.md,.markdown,.json,.html,.htm,.mhtml,.mht,text/plain,text/markdown,application/json,text/html"
                style={{ display: "none" }}
                onChange={(e) => {
                  void readAiFiles(Array.from(e.target.files ?? []));
                  e.target.value = "";
                }}
              />
              <Space wrap align="center">
                <Button size="small" disabled={!aiReady || aiBusy} onClick={() => aiFileRef.current?.click()}>
                  导入文件
                </Button>
                <Button
                  size="small"
                  disabled={!aiReady || aiBusy || aiUrlBusy}
                  onClick={() => {
                    setAiUrlOpen(true);
                    setAiUrlError("");
                  }}
                >
                  从 URL 导入
                </Button>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  支持 .txt / .md / .json / .html / .mhtml；可一次选多个页面，文件只在本地转文本
                </Typography.Text>
              </Space>
              {aiFiles.length > 0 && (
                <div style={{ border: "1px solid #f0f0f0", borderRadius: 6, padding: 8 }}>
                  <Space wrap align="center">
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      已导入 {aiFiles.length} 个（文件/页面），已选 {selectedAiFiles.length} 个，共{" "}
                      {aiSubmission.fileChars} 字
                    </Typography.Text>
                    {urlPageCount > 0 && (
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        URL 抓取 {urlPageCount} 页（{aiUrlAiUsed ? "AI 选页" : "关键词选页"}）
                      </Typography.Text>
                    )}
                  </Space>
                  {aiUrlWarnings.map((w, i) => (
                    <Alert key={i} type="warning" showIcon message={w} style={{ marginTop: 4 }} />
                  ))}
                  {aiFiles.map((f) => (
                    <div
                      key={f.id}
                      style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, padding: "3px 0" }}
                    >
                      <Checkbox checked={f.selected} onChange={() => toggleAiItem(f.id)} />
                      <div style={{ flex: "1 1 auto", minWidth: 0 }}>
                        <Typography.Text style={{ wordBreak: "break-all" }}>{f.name}</Typography.Text>
                        {f.source === "url" && f.url && (
                          <div>
                            <Typography.Text type="secondary" style={{ fontSize: 11, wordBreak: "break-all" }}>
                              {f.url}
                            </Typography.Text>
                          </div>
                        )}
                      </div>
                      <Tag color={f.source === "url" ? (f.reason === "ai" ? "blue" : "default") : "green"}>
                        {f.source === "url" ? (f.reason === "ai" ? "AI" : "URL") : "文件"}
                      </Tag>
                      <Typography.Text type="secondary">{f.chars} 字</Typography.Text>
                      <Button type="link" size="small" style={{ paddingInline: 0 }} onClick={() => removeAiFile(f.id)}>
                        移除
                      </Button>
                    </div>
                  ))}
                </div>
              )}
              <Input.TextArea
                rows={8}
                className="mono"
                value={aiDoc}
                disabled={!aiReady || aiBusy}
                onChange={(e) => {
                  setAiDoc(e.target.value);
                  setAiDraft(null);
                  setAiGate(null);
                  setAiApplied(false);
                  setAiFailure(null);
                }}
                placeholder="粘贴文本（可选）；页面文件请用上方「导入文件」或「从 URL 导入」"
              />
              <Space align="center" wrap>
                <Button
                  type="primary"
                  loading={aiBusy}
                  disabled={
                    !aiReady ||
                    Boolean(aiSubmission.error) ||
                    aiSubmission.chars < 200
                  }
                  onClick={() => void generateAiDraft()}
                >
                  生成配置
                </Button>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  将提交：粘贴 {aiSubmission.pasteChars} 字 + 附件/页面 {aiSubmission.fileChars} 字 ={" "}
                  {aiSubmission.chars} 字（至少 200；上限 {AI_DOC_MAX_BYTES / 1024}KB）
                </Typography.Text>
              </Space>
              {aiSubmission.error && <Alert type="error" showIcon message={aiSubmission.error} />}
              {aiFailure && (
                <Alert
                  type="error"
                  showIcon
                  message={aiFailure.title}
                  description={
                    <>
                      <ul style={{ margin: 0, paddingLeft: 18 }}>
                        {aiFailure.details.map((d, i) => <li key={i}>{d}</li>)}
                      </ul>
                      {["input", "invalid_draft", "doc_incomplete"].includes(aiFailure.kind) && (
                        <Collapse
                          size="small"
                          style={{ marginTop: 8 }}
                          items={[
                            {
                              key: "doc-checklist",
                              label: "如何整理 API 文档",
                              children: (
                                <ol style={{ margin: 0, paddingLeft: 18 }}>
                                  {AI_DOC_CHECKLIST.map((item) => <li key={item}>{item}</li>)}
                                </ol>
                              ),
                            },
                          ]}
                        />
                      )}
                      <Button size="small" style={{ marginTop: 8 }} onClick={() => void copyAiSupport()}>
                        复制诊断信息给技术支持
                      </Button>
                    </>
                  }
                />
              )}
              {aiApplied && aiDraft?.template && (
                <Alert
                  type="success"
                  showIcon
                  message="配置生成成功，已填入下方表单（未保存）"
                  description={
                    <>
                      <div>
                        已识别：<strong>{aiDraft.template.name}</strong>
                        {aiDraft.template.id && (
                          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                            {" "}（{aiDraft.template.id}）
                          </Typography.Text>
                        )}
                      </div>
                      <div
                        style={{
                          display: "grid",
                          gridTemplateColumns: "72px 1fr",
                          gap: "4px 8px",
                          fontSize: 12,
                          marginTop: 6,
                        }}
                      >
                        {aiSummary.map((row) => (
                          <div key={row.label} style={{ display: "contents" }}>
                            <span style={{ color: "#999" }}>{row.label}</span>
                            <span style={{ wordBreak: "break-all" }}>{row.value}</span>
                          </div>
                        ))}
                      </div>
                      <Space wrap style={{ marginTop: 8 }}>
                        <Button size="small" onClick={scrollToForm}>
                          检查下方表单
                        </Button>
                        <Button size="small" type="link" onClick={() => void copyAiSupport()}>
                          复制给技术支持
                        </Button>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          下一步：保存 → 测试「创建 + 查单」；开启回调验证时还要真实回调。
                        </Typography.Text>
                      </Space>
                    </>
                  }
                />
              )}
              {aiDraft?.template && (
                <>
                  {aiGate?.status === "soft_gaps" && aiGate.warnings.length > 0 && (
                    <Collapse
                      size="small"
                      items={[
                        {
                          key: "gaps",
                          label: `有 ${aiGate.warnings.length} 项需要人工确认（展开查看）`,
                          children: (
                            <ul style={{ margin: 0, paddingLeft: 18 }}>
                              {aiGate.warnings.map((w, i) => <li key={i}>{w}</li>)}
                            </ul>
                          ),
                        },
                      ]}
                    />
                  )}
                  <Collapse
                    size="small"
                    items={[
                      {
                        key: "details",
                        label: "查看配置摘要与 AI 依据",
                        children: (
                          <>
                            <Button size="small" style={{ marginBottom: 8 }} onClick={() => void copyAiSupport()}>
                              复制诊断信息给技术支持
                            </Button>
                            <Alert type="info" showIcon message="AI 草稿，未审核；请核对后保存并测试支付。" />
                            {aiPreview && (
                              <div>
                                <Typography.Text strong>配置摘要</Typography.Text>
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
                            {aiDraft.evidence.length > 0 && (
                              <div style={{ marginTop: 8 }}>
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
                              <div style={{ marginTop: 8 }}>
                                <Typography.Text strong>不确定点</Typography.Text>
                                <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
                                  {aiDraft.uncertainty.map((u, i) => <li key={i}>{u}</li>)}
                                </ul>
                              </div>
                            )}
                          </>
                        ),
                      },
                    ]}
                  />
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
        open={aiUrlOpen}
        title="从 URL 导入文档"
        okText="抓取并导入"
        cancelText="取消"
        confirmLoading={aiUrlBusy}
        onOk={() => void fetchAiDocFromUrl()}
        onCancel={() => {
          if (!aiUrlBusy) setAiUrlOpen(false);
        }}
      >
        <Space direction="vertical" size={10} style={{ width: "100%" }}>
          <Typography.Text type="secondary">
            只抓公开、同源、静态 HTML 的一层页面（最多 8 页、总正文 {AI_DOC_MAX_BYTES / 1024}KB）。登录页、JS 渲染页面
            抓不到；失败时请改用「导入文件」或粘贴。
          </Typography.Text>
          <Input
            value={aiUrl}
            disabled={aiUrlBusy}
            onChange={(e) => setAiUrl(e.target.value)}
            onPressEnter={() => {
              if (!aiUrlBusy) void fetchAiDocFromUrl();
            }}
            placeholder="https://www.yimapay.com/docs/api/index.html"
          />
          {aiUrlError && <Alert type="error" showIcon message={aiUrlError} />}
        </Space>
      </Modal>
      <Modal
        open={Boolean(pendingTemplate)}
        title="应用接口模板"
        okText="应用模板"
        cancelText="取消"
        width={560}
        onOk={applyPendingTemplate}
        onCancel={() => setPendingTemplate(null)}
      >
        {pendingTemplate && (
          <Space direction="vertical" size={10} style={{ width: "100%" }}>
            <Typography.Text>
              将用 <strong>{pendingTemplate.name}</strong> 覆盖当前接口配置。
            </Typography.Text>
            {pendingTemplate.description && (
              <Typography.Text type="secondary">{pendingTemplate.description}</Typography.Text>
            )}
            <Space wrap>
              <Tag color={pendingTemplate.source === "official" ? "green" : "orange"}>
                {pendingTemplate.source === "official" ? "官方模板" : "导入模板（未审核）"}
              </Tag>
              <Typography.Text type="secondary" code>{pendingTemplate.id}</Typography.Text>
            </Space>
            {pendingTemplate.source !== "official" && (
              <Alert
                type="warning"
                showIcon
                message="第三方/导入模板，未审核；应用后请人工核对并测试支付。"
              />
            )}
            <Alert
              type="info"
              showIcon
              message="应用后仍可修改；点「保存并返回」才会入库。"
              description="当前未保存的接口配置会被覆盖。"
            />
            {pendingTemplatePreview?.issues.map((issue) => (
              <Alert key={issue} type="warning" showIcon message={issue} />
            ))}
          </Space>
        )}
      </Modal>
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
