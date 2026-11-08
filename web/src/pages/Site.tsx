import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Popconfirm,
  Row,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
  message,
} from "antd";

import {
  api,
  ApiError,
  type SiteStateView,
  type SiteVersion,
} from "../api";

/**
 * 网站：**只做两件事**——看一眼现在线上是哪一版，点一下发布。
 *
 * 三条刻意的取舍（评审时别改回去）：
 *
 *  1. **一个主按钮**。页面里只有「发布站点」是 primary，回滚是表格里的次要操作。
 *     零技术租户面对两个同权重按钮时不知道该点哪个。
 *  2. **失败要说人话**。L0 闸门返回的 `issues[]` 逐条列出来（"缺 index.html"
 *     比 "l0_failed" 有用一百倍）；不给用户看错误码。
 *  3. **发布不等于保存**。发布是把当前数据渲染成静态文件写进 R2 再切指针，
 *     所以这里显示的永远是"线上"，改数据后要再点一次发布。
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
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [issues, setIssues] = useState<string[]>([]);

  const load = useCallback(async () => {
    try {
      setState(await api.site());
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : "读不到站点状态";
      message.error(msg);
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

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Row gutter={[16, 16]}>
        <Col xs={24} md={12}>
          <Card>
            <Statistic
              title="线上版本"
              value={active === null ? "尚未发布" : `第 ${active} 版`}
              loading={loading}
            />
            <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
              {published
                ? `发布于 ${fmtTime(published.created_at)}。改完数据要再点一次「发布站点」才会生效。`
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
            <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
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
            <Button
              type="primary"
              loading={busy}
              disabled={!templateReady}
            >
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
}
