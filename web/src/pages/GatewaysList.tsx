import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Button,
  Dropdown,
  Popconfirm,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from "antd";

import { api, ApiError, type GatewayView, type GatewaysResponse } from "../api";
import { GATEWAY_LIST_PATH, navigate } from "../nav";
import { DRIVER_LABEL, METHOD_LABEL, STATUS } from "./gateway-constants";

export default function GatewaysList() {
  const [data, setData] = useState<GatewaysResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.gateways());
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "加载失败");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * 测试支付：建一张 `source='test'` 的 0 权益测试单，用系统浏览器打开收银台。
   * 与真实下单的区别：允许 draft、忽略白名单、**不产生订阅**（契约 §2.4.5）。
   */
  async function testPay(gw: GatewayView, method: string) {
    const key = `test:${gw.id}`;
    if (busyKey) return;
    setBusyKey(key);
    try {
      const res = await api.testGateway(gw.id, { method, amount_minor: 100 });
      window.open(res.pay_url, "_blank", "noopener,noreferrer");
      message.success(`已建测试单 ${res.order_code}（${res.currency} ${(res.amount_minor / 100).toFixed(2)}）`);
    } catch (e) {
      message.error(e instanceof ApiError ? e.message || e.code : "测试支付失败");
    } finally {
      setBusyKey(null);
    }
  }

  async function act(key: string, fn: () => Promise<unknown>, ok: string) {
    if (busyKey) return;
    setBusyKey(key);
    try {
      await fn();
      message.success(ok);
      await load();
    } catch (e) {
      message.error(e instanceof ApiError ? e.message || e.code : "操作失败");
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {error && <Alert type="error" showIcon message={error} />}

      {data && !data.secret_key_ready && (
        <Alert
          type="warning"
          showIcon
          message="未配置主密钥 APP_SECRET"
          description="没有主密钥就无法保存网关密钥，真实网关无法发布。用 wrangler secret put APP_SECRET 配置。"
        />
      )}

      <div className="card">
        <div className="row between" style={{ marginBottom: 12 }}>
          <Space direction="vertical" size={0}>
            <Typography.Title level={5} style={{ margin: 0 }}>
              支付网关
            </Typography.Title>
          </Space>
          <Button
            type="primary"
            disabled={busyKey !== null}
            onClick={() => navigate(`${GATEWAY_LIST_PATH}/new`)}
          >
            新增网关
          </Button>
        </div>

        <Table<GatewayView>
          rowKey="id"
          size="small"
          dataSource={data?.gateways ?? []}
          pagination={false}
          columns={[
            {
              title: "名称",
              dataIndex: "name",
              width: 260,
              render: (name: string, gw) => (
                <Space direction="vertical" size={0} style={{ maxWidth: 240 }}>
                  <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</span>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {DRIVER_LABEL[gw.driver] ?? gw.driver}
                  </Typography.Text>
                </Space>
              ),
            },
            {
              title: "支付方式",
              dataIndex: "methods",
              width: 160,
              render: (m: string[]) => (
                <Space size={4} wrap>
                  {m.map((x) => (
                    <Tag key={x}>{METHOD_LABEL[x] ?? x}</Tag>
                  ))}
                </Space>
              ),
            },
            {
              title: "状态",
              dataIndex: "status",
              width: 90,
              render: (s: string) => <Tag color={STATUS[s]?.color}>{STATUS[s]?.text ?? s}</Tag>,
            },
            {
              title: "测试",
              key: "test",
              width: 120,
              render: (_: unknown, gw: GatewayView) =>
                gw.test_require_callback && !gw.test_callback_ok_at ? (
                  <Tag color="orange">等待通知</Tag>
                ) : gw.test_ready ? (
                  <Tag color="green">{gw.test_require_callback ? "全部通过" : "创建+查单已过"}</Tag>
                ) : gw.test_create_ok_at ? (
                  <Tag color="orange">查单未过</Tag>
                ) : (
                  <Tag>未测试</Tag>
                ),
            },
            { title: "优先级", dataIndex: "priority", width: 70 },
            {
              title: "密钥",
              dataIndex: "has_secret",
              width: 70,
              render: (has: boolean) => (has ? <Tag color="blue">已设置</Tag> : <Tag>未设置</Tag>),
            },
            {
              title: "最近成功",
              dataIndex: "last_ok_at",
              width: 150,
              render: (v: string | null) => (v ? new Date(v).toLocaleString() : "—"),
            },
            {
              title: "操作",
              key: "actions",
              width: 280,
              render: (_, gw) => (
                <Space size={4}>
                  <Button
                    size="small"
                    disabled={busyKey !== null}
                    onClick={() => navigate(`${GATEWAY_LIST_PATH}/${gw.id}/edit`)}
                  >
                    编辑
                  </Button>
                  <Button
                    size="small"
                    loading={busyKey === `copy:${gw.id}`}
                    disabled={busyKey !== null && busyKey !== `copy:${gw.id}`}
                    onClick={() => void act(`copy:${gw.id}`, () => api.copyGateway(gw.id), "已复制为草稿")}
                  >
                    复制
                  </Button>
                  {gw.status !== "live" && (
                    <Button
                      size="small"
                      type="primary"
                      loading={busyKey === `publish:${gw.id}`}
                      disabled={
                        busyKey !== null && busyKey !== `publish:${gw.id}` ||
                        !gw.test_ready ||
                        (gw.test_require_callback && !gw.test_callback_ok_at)
                      }
                      title={
                        !gw.test_ready
                          ? "先完成测试（创建订单 + 查询订单）"
                          : gw.test_require_callback && !gw.test_callback_ok_at
                            ? "已开启通知验证，等待测试支付通知"
                            : undefined
                      }
                      onClick={() => void act(`publish:${gw.id}`, () => api.publishGateway(gw.id), "已启用")}
                    >
                      发布
                    </Button>
                  )}
                  <Dropdown
                    trigger={["click"]}
                    menu={{
                      items: gw.methods.map((m) => ({
                        key: m,
                        label: `测试 ${METHOD_LABEL[m] ?? m}`,
                        onClick: () => void testPay(gw, m),
                      })),
                    }}
                    disabled={busyKey !== null || gw.methods.length === 0}
                  >
                    <Button
                      size="small"
                      loading={busyKey === `test:${gw.id}`}
                      disabled={busyKey !== null && busyKey !== `test:${gw.id}`}
                    >
                      测试支付
                    </Button>
                  </Dropdown>
                  {gw.status === "live" && (
                    <Popconfirm
                      title="停用后 App 里立刻看不到这个支付方式"
                      onConfirm={() => void act(`disable:${gw.id}`, () => api.disableGateway(gw.id), "已停用")}
                    >
                      <Button
                        size="small"
                        danger
                        loading={busyKey === `disable:${gw.id}`}
                        disabled={busyKey !== null && busyKey !== `disable:${gw.id}`}
                      >
                        停用
                      </Button>
                    </Popconfirm>
                  )}
                  <Popconfirm
                    title="删除这个支付网关？"
                    description={
                      gw.driver === "stripe" || gw.driver === "paypal"
                        ? "删除后列表不再显示，收银台立即下线；历史订单和在途通知保留。Stripe/PayPal 后台的 Webhook 地址也要删除或改到新网关。"
                        : "删除后列表不再显示，收银台立即下线；历史订单和在途通知保留。"
                    }
                    okText="删除"
                    okButtonProps={{ danger: true }}
                    onConfirm={() => void act(`delete:${gw.id}`, () => api.deleteGateway(gw.id), "已删除")}
                  >
                    <Button
                      size="small"
                      danger
                      type="text"
                      loading={busyKey === `delete:${gw.id}`}
                      disabled={busyKey !== null && busyKey !== `delete:${gw.id}`}
                    >
                      删除
                    </Button>
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
          expandable={{
            expandedRowRender: (gw) => (
              <Space direction="vertical" size={4} style={{ fontSize: 12 }}>
                <span>网关地址：{gw.endpoint || "—"}</span>
                <span>{gw.driver === "paypal" ? "Client ID" : "商户号"}：{gw.merchant_id || "—"}</span>
                {gw.driver === "paypal" && (
                  <span>
                    PayPal 环境：
                    {gw.paypal_env === "sandbox" ? "Sandbox（测试）" : gw.paypal_env === "live" ? "Live（正式）" : "跟随部署环境"}
                  </span>
                )}
                {(gw.driver === "stripe" || gw.driver === "paypal") && (
                  <span>Webhook：{gw.has_webhook ? "已配置" : "未配置"}</span>
                )}
                <span>
                  客户白名单：
                  {gw.allowed_emails.length ? gw.allowed_emails.join(", ") : "不限"}
                  {gw.driver === "mock" && !gw.allowed_emails.length ? "（测试网关必须非空才能发布）" : ""}
                </span>
                {gw.last_error && <span style={{ color: "#cf1322" }}>最近错误：{gw.last_error}</span>}
              </Space>
            ),
          }}
        />
      </div>
    </div>
  );
}
