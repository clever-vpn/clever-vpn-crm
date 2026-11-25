import { useEffect, useRef, useState } from "react";
import {
  Alert,
  Button,
  Checkbox,
  Modal,
  Collapse,
  Form,
  Input,
  InputNumber,
  Radio,
  Select,
  Switch,
  Space,
  Tabs,
  Tag,
  Typography,
  message,
} from "antd";

import { api, ApiError, type GatewayDraft, type GatewayView, type GatewaysResponse } from "../api";
import { defaultMethods, driverFields, secretFieldLabel, visibleDrivers } from "../gateway-form";
import { fromMapping, requiredChecks } from "../mapping-form";
import { GATEWAY_LIST_PATH, navigate, setNavGuard } from "../nav";
import GatewayMappingEditor from "./GatewayMappingEditor";
import { DRIVER_LABEL, METHOD_LABEL, STATUS } from "./gateway-constants";

interface FormValues {
  driver: string;
  name: string;
  endpoint?: string;
  paypal_env?: "sandbox" | "live";
  merchant_id?: string;
  secret?: string;
  webhook_secret?: string;
  methods: string[];
  channel_codes?: Record<string, string | number>;
  priority: number;
  currency: string;
  fx_rate: string;
  test_amount: string;
  test_require_callback: boolean;
  allowed_emails?: string;
}

interface Props {
  mode: "new" | "edit";
  id?: number;
}

function PaymentMethodsEditor({
  options,
  methods,
  codes,
  showChannel,
  disabled,
  onChange,
}: {
  options: { value: string; label: string }[];
  methods: string[];
  codes: Record<string, string | number>;
  showChannel: boolean;
  disabled?: boolean;
  onChange: (nextMethods: string[], nextCodes: Record<string, string | number>) => void;
}) {
  if (!showChannel) {
    return (
      <Select
        mode="multiple"
        value={methods}
        onChange={(next: string[]) => onChange(next, codes)}
        options={options}
        placeholder="选择支付方式"
        disabled={disabled}
      />
    );
  }
  return (
    <Space direction="vertical" size={6} style={{ width: "100%" }}>
      {options.map((option) => (
        <div key={option.value} style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <Typography.Text style={{ width: 100, flex: "0 0 100px" }}>{option.label}</Typography.Text>
          <Input
            value={codes[option.value] === undefined ? "" : String(codes[option.value])}
            onChange={(e) => {
              const value = e.target.value;
              const nextCodes = { ...codes };
              if (value.trim()) nextCodes[option.value] = value;
              else delete nextCodes[option.value];
              const nextMethods = options
                .filter((o) => String(nextCodes[o.value] ?? "").trim() !== "")
                .map((o) => o.value);
              onChange(nextMethods, nextCodes);
            }}
            placeholder="通道号；为空 = 该支付方式不可用"
          />
        </div>
      ))}
      {options.length === 0 && <Typography.Text type="secondary">没有可选的支付方式</Typography.Text>}
    </Space>
  );
}
export default function GatewayEditor({ mode, id }: Props) {
  const [data, setData] = useState<GatewaysResponse | null>(null);
  const [editing, setEditing] = useState<GatewayView | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [tab, setTab] = useState("basic");
  const [mappingJson, setMappingJson] = useState("");
  const [mappingInitial, setMappingInitial] = useState<unknown>(null);
  const [mappingMissing, setMappingMissing] = useState(0);
  const [mappingJsonDirty, setMappingJsonDirty] = useState(false);
  const [mappingAttempted, setMappingAttempted] = useState(false);
  const [mappingWarnings, setMappingWarnings] = useState<string[]>([]);
  const [warningsOpen, setWarningsOpen] = useState(false);
  const warningsConfirmedRef = useRef(false);
  const [dirty, setDirty] = useState(false);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [pendingNavHref, setPendingNavHref] = useState<string | null>(null);
  const dirtyRef = useRef(false);
  const hydratingRef = useRef(true);
  const [form] = Form.useForm<FormValues>();

  const driver: string = Form.useWatch("driver", form) ?? "epay_v1";
  const driverMethods = data?.drivers.find((d) => d.driver === driver)?.methods ?? [];
  const fields = driverFields(driver);
  const driverChoices = visibleDrivers(data?.drivers ?? [], {
    current: editing?.driver ?? null,
  });
  const methodsWatch: string[] = Form.useWatch("methods", form) ?? [];
  const channelCodesWatch: Record<string, string | number> = Form.useWatch("channel_codes", form) ?? {};
  const methodsKey = methodsWatch.join(",");
  const hasChannel = driver === "epay_v1" || driver === "generic_json_v1";
  const endpointWatch: string | undefined = Form.useWatch("endpoint", form);
  const nameWatch: string | undefined = Form.useWatch("name", form);
  const testRequireCallback: boolean = Form.useWatch("test_require_callback", form) ?? false;
  const paypalEnvWatch: "sandbox" | "live" | undefined = Form.useWatch("paypal_env", form);
  /** 已发布：支付协议字段只读；名称/优先级/白名单/汇率/测试设置仍可改。 */
  const protocolLocked = editing?.status === "live";
  /** 驱动只在草稿可改；已发布/已停用都只能复制。 */
  const driverLocked = mode === "edit" && editing !== null && editing.status !== "draft";

  function markDirty(): void {
    if (hydratingRef.current) return;
    setSaveError(null);
    if (dirtyRef.current) return;
    dirtyRef.current = true;
    setDirty(true);
  }

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      hydratingRef.current = true;
      try {
        const res = await api.gateways();
        if (!alive) return;
        setData(res);
        if (mode === "edit") {
          const gw = res.gateways.find((g) => g.id === id);
          if (!gw) {
            message.error("网关不存在或已删除");
            dirtyRef.current = false;
            setDirty(false);
            navigate(GATEWAY_LIST_PATH);
            return;
          }
          setEditing(gw);
          const channelCodes = gw.channel_codes ?? {};
          const channelDriver = gw.driver === "epay_v1" || gw.driver === "generic_json_v1";
          form.setFieldsValue({
            driver: gw.driver,
            name: gw.name,
            endpoint: gw.endpoint ?? "",
            paypal_env: gw.paypal_env === "live" ? "live" : "sandbox",
            merchant_id: gw.merchant_id ?? "",
            secret: "",
            webhook_secret: "",
            methods: channelDriver
              ? Object.keys(channelCodes).filter((m) => String(channelCodes[m] ?? "").trim() !== "")
              : gw.methods,
            channel_codes: channelCodes,
            priority: gw.priority,
            currency: gw.currency,
            fx_rate: String(gw.fx_rate ?? 1),
            test_amount: (gw.test_amount_minor / 100).toFixed(2),
            test_require_callback: gw.test_require_callback,
            allowed_emails: gw.allowed_emails.join(", "),
          });
          if (gw.has_secret) {
            // 像普通密码框：编辑时直接带出当前值，用户可显隐/就地改
            try {
              const { secret } = await api.revealGatewaySecret(gw.id);
              if (!alive) return;
              form.setFieldValue("secret", secret);
            } catch {
              message.warning("当前密钥加载失败；留空保存不会修改");
            }
          }
          setMappingJson(gw.mapping ? JSON.stringify(gw.mapping, null, 2) : "");
          setMappingInitial(gw.mapping ?? null);
          if (gw.driver === "generic_json_v1") {
            const parsed = fromMapping(gw.mapping ?? null, gw.methods);
            const missing = requiredChecks(parsed.state).filter((c) => !c.ok).length;
            setMappingMissing(missing);
          } else {
            setMappingMissing(0);
          }
          setMappingJsonDirty(false);
          setMappingAttempted(false);
        } else {
          setEditing(null);
          form.setFieldsValue({
            driver: "epay_v1",
            name: "",
            endpoint: "",
            paypal_env: "sandbox",
            merchant_id: "",
            secret: "",
            webhook_secret: "",
            methods: ["alipay", "wechat"],
            channel_codes: { alipay: "alipay", wechat: "wxpay" },
            priority: 100,
            currency: "CNY",
            fx_rate: "1",
            test_amount: "1.00",
            test_require_callback: false,
            allowed_emails: "",
          });
          setMappingJson("");
          setMappingInitial(null);
          setMappingMissing(0);
          setMappingJsonDirty(false);
          setMappingAttempted(false);
        }
        setLoadError(null);
        dirtyRef.current = false;
        setDirty(false);
        window.setTimeout(() => {
          hydratingRef.current = false;
        }, 0);
      } catch (e) {
        if (!alive) return;
        setLoadError(e instanceof ApiError ? e.message || e.code : "加载失败");
      } finally {
        if (alive) setLoading(false);
        window.setTimeout(() => {
          hydratingRef.current = false;
        }, 0);
      }
    })();
    return () => {
      alive = false;
    };
    // form 是稳定的实例；mode/id 变化时整页应重新加载
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, id]);

  useEffect(() => {
    return setNavGuard((href) => {
      if (!dirtyRef.current) return true;
      setPendingNavHref(href);
      setLeaveOpen(true);
      return false;
    });
  }, []);

  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  function cancel(): void {
    if (dirtyRef.current) {
      setPendingNavHref(GATEWAY_LIST_PATH);
      setLeaveOpen(true);
      return;
    }
    navigate(GATEWAY_LIST_PATH);
  }

  function leaveWithoutSaving(): void {
    const href = pendingNavHref ?? GATEWAY_LIST_PATH;
    dirtyRef.current = false;
    setDirty(false);
    setLeaveOpen(false);
    setPendingNavHref(null);
    navigate(href);
  }

  function onDriverChange(next: string): void {
    const allowed = data?.drivers.find((d) => d.driver === next)?.methods ?? [];
    const nextCodes = next === "epay_v1" ? { alipay: "alipay", wechat: "wxpay" } : {};
    const nextMethods = next === "epay_v1" || next === "generic_json_v1"
      ? Object.keys(nextCodes)
      : defaultMethods(next, allowed);
    form.setFieldValue("methods", nextMethods);
    form.setFieldValue("channel_codes", nextCodes);
    setMappingAttempted(false);
    if (next !== "generic_json_v1" && tab === "mapping") setTab("basic");
    markDirty();
  }

  function notifyUrlFor(gatewayId: number): string {
    return `${window.location.origin}/api/pay/notify/${gatewayId}`;
  }

  async function copyNotifyUrl(url: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(url);
      message.success("已复制 Webhook 地址");
    } catch {
      message.info(url);
    }
  }


  async function testNow(): Promise<void> {
    if (!editing) {
      message.info("先保存草稿，再测试");
      return;
    }
    const methods = (form.getFieldValue("methods") as string[] | undefined) ?? [];
    const method = methods[0];
    if (!method) {
      message.error("先配置至少一个支付方式");
      return;
    }
    const amount = Math.round(Number(form.getFieldValue("test_amount") ?? 1) * 100);
    setBusy(true);
    try {
      const res = await api.testGateway(editing.id, { method, amount_minor: amount });
      window.open(res.pay_url, "_blank", "noopener,noreferrer");
      message.success(
        res.callback_required
          ? `已建测试单 ${res.order_code}（${res.currency} ${(res.amount_minor / 100).toFixed(2)}），创建+查询通过；等待通知验证`
          : `已建测试单 ${res.order_code}（${res.currency} ${(res.amount_minor / 100).toFixed(2)}），创建+查询通过`,
      );
      const refreshed = await api.gateways();
      setData(refreshed);
      const updated = refreshed.gateways.find((g) => g.id === editing.id);
      if (updated) setEditing(updated);
    } catch (e) {
      message.error(e instanceof ApiError ? e.message || e.code : "测试失败");
    } finally {
      setBusy(false);
    }
  }

  async function save(): Promise<void> {
    const v = await form.validateFields().catch(() => null);
    if (!v) {
      setTab("basic");
      const first = form.getFieldsError().find((e) => e.errors.length > 0);
      if (first) {
        window.setTimeout(() => {
          form.scrollToField(first.name, { behavior: "smooth", block: "center" });
        }, 0);
      }
      return;
    }
    if (v.driver === "generic_json_v1") {
      if (mappingJsonDirty) {
        setMappingAttempted(true);
        setSaveError("高级 JSON 有未应用修改，先点「应用 JSON 到表单」");
        setTab("mapping");
        return;
      }
      if (mappingMissing > 0) {
        setMappingAttempted(true);
        setSaveError(`接口配置还有 ${mappingMissing} 项必填`);
        setTab("mapping");
        return;
      }
      if (mappingWarnings.length > 0 && !warningsConfirmedRef.current) {
        setWarningsOpen(true);
        return;
      }
    }
    let mapping: unknown = undefined;
    if (mappingJson.trim()) {
      try {
        mapping = JSON.parse(mappingJson) as unknown;
      } catch {
        message.error("接口配置不是合法 JSON");
        return;
      }
    }
    setBusy(true);
    setSaveError(null);
    try {
      const emails = (v.allowed_emails ?? "")
        .split(/[,\s]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      // 已发布时协议字段只读：只提交基本信息，避免把预填的 secret/mapping 当成“修改”。
      const payload: GatewayDraft = protocolLocked
        ? {
            driver: v.driver,
            name: v.name,
            methods: v.methods,
            priority: v.priority,
            fx_rate: Number(v.fx_rate),
            test_amount_minor: Math.round(Number(v.test_amount) * 100),
            test_require_callback: v.test_require_callback,
            allowed_emails: emails,
          }
        : {
            driver: v.driver,
            name: v.name,
            endpoint: v.endpoint || null,
            paypal_env: v.driver === "paypal" ? (v.paypal_env ?? "sandbox") : null,
            merchant_id: v.merchant_id || null,
            methods: v.methods,
            channel_codes: v.channel_codes ?? {},
            priority: v.priority,
            currency: v.currency,
            fx_rate: Number(v.fx_rate),
            test_amount_minor: Math.round(Number(v.test_amount) * 100),
            test_require_callback: v.test_require_callback,
            allowed_emails: emails,
          };
      if (!protocolLocked && v.secret && v.secret.trim()) payload.secret = v.secret.trim();
      if (!protocolLocked && v.webhook_secret && v.webhook_secret.trim()) payload.webhook_secret = v.webhook_secret.trim();
      if (!protocolLocked && mapping !== undefined) payload.mapping = mapping;

      if (mode === "edit" && editing) await api.updateGateway(editing.id, payload);
      else await api.createGateway(payload);

      dirtyRef.current = false;
      setDirty(false);
      message.success(mode === "edit" ? "已保存" : "已创建草稿（发布后租户才看得到）");
      navigate(GATEWAY_LIST_PATH);
    } catch (e) {
      const text = e instanceof ApiError ? e.message || e.code : "保存失败";
      setSaveError(text);
      message.error(text);
    } finally {
      setBusy(false);
    }
  }

  const saveDisabled = busy || loading;

  if (loadError) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Alert type="error" showIcon message={loadError} />
        <Button onClick={cancel}>返回列表</Button>
      </div>
    );
  }

  const basicPane = (
    <>
        {(protocolLocked || driverLocked) && (
          <Alert
            type={protocolLocked ? "warning" : "info"}
            showIcon
            style={{ marginBottom: 12 }}
            message={protocolLocked ? "已发布网关：支付协议配置只读" : "网关类型已锁定"}
            description={
              protocolLocked
                ? "网关类型/驱动已锁定；修改网关地址/商户号/密钥/Webhook/支付方式/通道号/接口映射/币种/PayPal 环境，请先停用。名称/优先级/白名单/汇率/测试设置可直接修改。"
                : "换驱动请复制成新网关；支付协议配置可直接修改，保存后需要重新测试并发布。"
            }
          />
        )}
        <Form form={form} layout="vertical" onValuesChange={markDirty} scrollToFirstError>
          <Form.Item label="网关类型" name="driver" rules={[{ required: true }]}>
            <Select
              disabled={driverLocked}
              options={driverChoices.map((d) => ({
                value: d.driver,
                label: DRIVER_LABEL[d.driver] ?? d.driver,
              }))}
              onChange={onDriverChange}
            />
          </Form.Item>

          {driver === "manual" && (
            <Alert
              type="warning"
              showIcon
              message="对公转账不再作为网关创建项；已有行可以停用。"
              style={{ marginBottom: 16 }}
            />
          )}

          {driver === "paypal" && (
            <Form.Item
              label="PayPal 环境"
              name="paypal_env"
              extra="Sandbox 不会真实扣款；发布前必须配置非空客户白名单。"
            >
              <Radio.Group disabled={protocolLocked}>
                <Space direction="vertical" size={4}>
                  <Radio value="sandbox">Sandbox（测试，不会真实扣款）</Radio>
                  <Radio value="live">Live（正式收款，会真实扣款）</Radio>
                </Space>
              </Radio.Group>
            </Form.Item>
          )}
          {driver === "paypal" && paypalEnvWatch === "sandbox" && (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 12 }}
              message="PayPal Sandbox：不会真实扣款"
              description="只对客户白名单开放；发布前必须配置至少一个测试邮箱。"
            />
          )}
          {driver === "paypal" && paypalEnvWatch === "live" && (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 12 }}
              message="PayPal Live：会真实扣款"
              description="请确认已用 Sandbox 完成测试，再切换为 Live。"
            />
          )}

          <Form.Item label="内部名称" name="name" rules={[{ required: true }]}>
            <Input placeholder="例如：主号" maxLength={60} />
          </Form.Item>

          {fields.endpoint && (
            <Form.Item label="网关地址" name="endpoint" rules={[{ required: true }]}>
              <Input disabled={protocolLocked} placeholder="https://pay.example.com" />
            </Form.Item>
          )}

          {fields.merchant && (
            <Form.Item label={fields.merchantLabel} name="merchant_id" rules={[{ required: true }]}>
              <Input disabled={protocolLocked} placeholder={driver === "paypal" ? "PayPal Client ID" : "pid / mchId / appid"} />
            </Form.Item>
          )}

          {fields.secret && (
            <Form.Item label={secretFieldLabel(driver)} name="secret">
              {driver === "epay_v2" ? (
                <Input.TextArea
                  disabled={protocolLocked}
                  rows={4}
                  placeholder='{"merchant_private_key":"-----BEGIN PRIVATE KEY-----...","platform_public_key":"-----BEGIN PUBLIC KEY-----..."}'
                />
              ) : (
                <Input.Password autoComplete="new-password" />
              )}
            </Form.Item>
          )}

          {fields.webhook && (
            <>
              <Form.Item label={fields.webhookLabel} name="webhook_secret">
                {driver === "paypal" ? (
                  <Input disabled={protocolLocked} placeholder="WH-..." />
                ) : (
                  <Input.Password disabled={protocolLocked} autoComplete="new-password" placeholder="whsec_..." />
                )}
              </Form.Item>
              <Form.Item label="Webhook 地址">
                {editing ? (
                  <Space.Compact style={{ width: "100%" }}>
                    <Input readOnly value={notifyUrlFor(editing.id)} />
                    <Button onClick={() => void copyNotifyUrl(notifyUrlFor(editing.id))}>复制</Button>
                  </Space.Compact>
                ) : (
                  <Typography.Text type="secondary">保存草稿后显示</Typography.Text>
                )}
              </Form.Item>
            </>
          )}

          <Form.Item name="methods" hidden rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="channel_codes" hidden>
            <Input />
          </Form.Item>
          {fields.methods && (
            <Form.Item
              label={hasChannel ? "支付方式 / 通道号" : "支付方式"}
              extra={hasChannel
                ? driver === "generic_json_v1"
                  ? "通道号与支付方式一一对应；填了才可用，为空 = 该方式不可用；需在接口配置声明支付方式字段后才会发送"
                  : "通道号与支付方式一一对应；填了才可用，为空 = 该方式不可用"
                : driver === "epay_v2"
                  ? "易支付 V2 的 type 就是支付方式，没有独立通道号"
                  : ""}
            >
              <PaymentMethodsEditor
                options={driverMethods.map((m) => ({ value: m, label: METHOD_LABEL[m] ?? m }))}
                methods={methodsWatch}
                codes={channelCodesWatch}
                showChannel={hasChannel}
                disabled={protocolLocked}
                onChange={(nextMethods, nextCodes) => {
                  form.setFieldValue("methods", nextMethods);
                  form.setFieldValue("channel_codes", nextCodes);
                  markDirty();
                }}
              />
            </Form.Item>
          )}

          {driver === "mock" && (
            <Form.Item
              label="客户白名单"
              name="allowed_emails"
              rules={[{ required: true, message: "测试网关必须填写白名单" }]}
            >
              <Input placeholder="a@example.com, b@example.com" />
            </Form.Item>
          )}

          <Collapse
            items={[
              {
                key: "advanced",
                label: "高级",
                forceRender: true,
                children: (
                  <>
                    <Form.Item label="结算币种" name="currency" extra="网关实际扣款币种，如 CNY / USD">
            <Select
              disabled={protocolLocked}
              options={[
                { value: "CNY", label: "CNY" },
                { value: "USD", label: "USD" },
                { value: "EUR", label: "EUR" },
              ]}
            />
          </Form.Item>
          <Form.Item label="测试必须验证通知" name="test_require_callback" valuePropName="checked" extra="开启后，测试支付通知到账才算测试通过">
            <Switch />
          </Form.Item>
          <Form.Item label="汇率（1 网关币种 = X CNY）" name="fx_rate" extra="CNY 网关填 1；USD 网关按实际汇率">
            <InputNumber min={0.0001} step={0.01} precision={4} style={{ width: 220 }} />
          </Form.Item>
          <Form.Item label="测试金额（网关币种）" name="test_amount" extra="低于网关最低限额时测试会失败">
            <InputNumber min={0.01} precision={2} style={{ width: 220 }} />
          </Form.Item>
          <Form.Item label="优先级" name="priority" extra="数字小的先试">
                      <InputNumber min={0} style={{ width: 160 }} />
                    </Form.Item>
                    {driver !== "mock" && (
                      <Form.Item label="客户白名单" name="allowed_emails">
                        <Input placeholder="a@example.com, b@example.com" />
                      </Form.Item>
                    )}
                    {fields.mapping === "epay" && (
                      <Form.Item label="覆盖接口配置（JSON，可选）" extra="只写与默认值不同的部分">
                        <Input.TextArea
                          disabled={protocolLocked}
                          rows={6}
                          className="mono"
                          placeholder="{ }"
                          value={mappingJson}
                          onChange={(e) => {
                            setMappingJson(e.target.value);
                            markDirty();
                          }}
                        />
                      </Form.Item>
                    )}
                  </>
                ),
              },
            ]}
          />
        </Form>
        {editing && (
          <div className="card" style={{ marginTop: 12 }}>
            <Space direction="vertical" size={8} style={{ width: "100%" }}>
              <Typography.Text strong>测试</Typography.Text>
              <Space wrap>
                {editing.test_callback_ok_at ? (
                  <Tag color="green">创建 + 查单 + 通知已通过</Tag>
                ) : testRequireCallback ? (
                  <Tag color="orange">等待通知验证</Tag>
                ) : editing.test_ready ? (
                  <Tag color="blue">创建 + 查单已通过（通知未验证）</Tag>
                ) : editing.test_create_ok_at ? (
                  <Tag color="orange">创建通过，查单未通过</Tag>
                ) : (
                  <Tag>未测试</Tag>
                )}
                <Button loading={busy} onClick={() => void testNow()}>测试支付</Button>
              </Space>
              <Typography.Text type="secondary">
                发布前必须完成：创建订单 + 查询订单。通知可选；通知验证后才会显示“通知已通过”。
              </Typography.Text>
            </Space>
          </div>
        )}
    </>
  );

  const saveErrorAlert = saveError ? (
    <Alert type="error" showIcon message={saveError} style={{ marginBottom: 12 }} />
  ) : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {loading && <Alert type="info" showIcon message="加载中…" />}
      {data && !data.secret_key_ready && (
        <Alert
          type="warning"
          showIcon
          message="未配置主密钥 APP_SECRET"
          description="没有主密钥就无法保存网关密钥，真实网关无法发布。"
        />
      )}

      <div className="card">
        <Tabs
          className="gateway-tabs"
          activeKey={tab}
          onChange={setTab}
          tabBarStyle={{
            position: "sticky",
            top: 64,
            zIndex: 10,
            background: "var(--surface)",
          }}
          tabBarExtraContent={{
            left: (
              <Space size={8} wrap style={{ paddingInlineEnd: 12 }}>
                <Typography.Text
                  strong
                  className="gateway-editor-title"
                  style={{ maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                >
                  {mode === "new" ? "新增支付网关" : editing?.name ?? "编辑支付网关"}
                </Typography.Text>
                {editing && (
                  <Tag color={STATUS[editing.status]?.color}>
                    {STATUS[editing.status]?.text ?? editing.status}
                  </Tag>
                )}
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {DRIVER_LABEL[driver] ?? driver}
                </Typography.Text>
              </Space>
            ),
            right: (
              <Space size={8}>
                {dirty && <Tag color="gold">未保存</Tag>}
                <Button onClick={cancel}>取消</Button>
                <Button type="primary" loading={busy} disabled={saveDisabled} onClick={() => void save()}>
                  保存并返回
                </Button>
              </Space>
            ),
          }}
          items={[
            {
              key: "basic",
              label: "基本信息",
              children: (
                <>
                  {saveErrorAlert}
                  {basicPane}
                </>
              ),
            },
            ...(fields.mapping === "generic"
              ? [
                  {
                    key: "mapping",
                    label: "接口配置",
                    forceRender: true,
                    children: protocolLocked ? (
                      <>
                        {saveErrorAlert}
                        <Alert
                          type="warning"
                          showIcon
                          style={{ marginBottom: 12 }}
                          message="接口配置已锁定"
                          description="已发布网关的接口映射只读；需要修改请先停用，再重新测试并发布。"
                        />
                        <Input.TextArea
                          className="mono"
                          rows={18}
                          readOnly
                          value={mappingJson}
                          placeholder="（当前没有接口映射）"
                        />
                      </>
                    ) : (
                      <>
                        {saveErrorAlert}
                        <GatewayMappingEditor
                          key={mappingInitial ? `mapping-${editing?.id ?? "new"}` : "mapping-new"}
                          initial={mappingInitial}
                          methods={methodsWatch}
                          endpoint={endpointWatch || null}
                          onChange={(mapping) => {
                            warningsConfirmedRef.current = false;
                            setMappingJson(JSON.stringify(mapping, null, 2));
                            markDirty();
                          }}
                          onStatus={(status) => {
                            setMappingMissing(status.missing);
                            setMappingWarnings(status.warnings ?? []);
                            setMappingJsonDirty(status.jsonDirty);
                            if (status.jsonDirty) markDirty();
                          }}
                          attempted={mappingAttempted}
                          gatewayName={nameWatch ?? editing?.name ?? ""}
                          aiReady={Boolean(data?.ai_ready)}
                        />
                      </>
                    ),
                  },
                ]
              : []),
          ]}
        />
      </div>
      <Modal
        open={leaveOpen}
        title="离开当前编辑？"
        okText="放弃修改"
        cancelText="继续编辑"
        okButtonProps={{ danger: true }}
        onOk={leaveWithoutSaving}
        onCancel={() => {
          setLeaveOpen(false);
          setPendingNavHref(null);
        }}
      >
        <Typography.Paragraph style={{ margin: 0 }}>
          有未保存的修改。离开后这些修改不会保存。
        </Typography.Paragraph>
      </Modal>
      <Modal
        open={warningsOpen}
        title="保存前核对"
        okText="继续保存"
        cancelText="返回修改"
        onOk={() => {
          warningsConfirmedRef.current = true;
          setWarningsOpen(false);
          void save();
        }}
        onCancel={() => setWarningsOpen(false)}
      >
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          {mappingWarnings.map((w) => <li key={w}>{w}</li>)}
        </ul>
      </Modal>
    </div>
  );
}
