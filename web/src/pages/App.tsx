/**
 * 应用：打开 App 设计器。
 *
 * 这一页只有一件事：**选一间仓库 → 打开设计器**（`decisions-amend-4` 的后续：
 * 一个仓库 = 一个 App = 一份草稿）。所以它不展示分支 / PR / 版本 —— 那些都在
 * 设计器里，CRM 也不知道。
 *
 * 三种状态：
 *   · 列表为空        → 只有「连接新的仓库」（= 不带 repo 打开 studio，由 studio 引导绑定）
 *   · 有仓库          → 每行一个「打开」，带 repo 取票
 *   · 打开失败        → 说清是"没配地址"还是"studio 不可达"，不吞错误
 */
import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Button,
  Card,
  Empty,
  List,
  Space,
  Tag,
  Typography,
  message,
} from "antd";
import { AppstoreAddOutlined, ExportOutlined } from "@ant-design/icons";

import { ApiError, api } from "../api";

interface BoundRepo {
  repo: string;
  bound_at: string;
  last_used_at: string | null;
}

const fmtTime = (iso: string | null): string => {
  if (!iso) return "从没打开过";
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "——";
  const diff = Date.now() - at;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
};

/** `acme/my-vpn` → `my-vpn`（页面上只露项目名，不露 GitHub 账号） */
const shortName = (repo: string): string => repo.split("/")[1] ?? repo;

export default function AppPage() {
  const [repos, setRepos] = useState<BoundRepo[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api.appRepos();
      setRepos(data.repos);
      setError(null);
    } catch (e) {
      setRepos([]);
      setError(e instanceof ApiError ? e.message : "读不到已连接的仓库");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** `repo` 为空 = 连接新的仓库（studio 会显示绑定引导） */
  async function open(repo?: string) {
    setBusy(repo ?? "new");
    try {
      const { url } = await api.studioTicketApp(repo);
      window.location.assign(url);
    } catch (e) {
      const msg =
        e instanceof ApiError && e.body?.error === "studio_not_configured"
          ? "设计器还没启用：先在部署里配 STUDIO_APP_URL（app-studio 的地址）。"
          : e instanceof ApiError
            ? e.message
            : "打不开设计器";
      message.error(msg);
      setBusy(null);
    }
  }

  const empty = repos !== null && repos.length === 0;

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Card
        title="应用"
        extra={
          <Button
            type={empty ? "primary" : "default"}
            icon={<AppstoreAddOutlined />}
            loading={busy === "new"}
            onClick={() => open()}
          >
            连接新的仓库
          </Button>
        }
      >
        <Typography.Paragraph style={{ marginBottom: 8 }}>
          一个仓库就是一个 App。选一个打开设计器：文案、配色、页面都在那里改，改完点「发布」，
          安装包也会出现在设计器里。
        </Typography.Paragraph>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          第一次使用需要授权一次 GitHub 仓库（约 10 秒）；之后从这一页打开就行。
        </Typography.Paragraph>
      </Card>

      {error ? <Alert type="warning" showIcon message={error} /> : null}

      <Card>
        {repos === null ? (
          <Typography.Text type="secondary">读取中…</Typography.Text>
        ) : empty ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              <span>
                还没有连接仓库。
                <br />
                点右上角「连接新的仓库」开始，设计器会引导你完成授权。
              </span>
            }
          />
        ) : (
          <List
            dataSource={repos}
            renderItem={(item) => (
              <List.Item
                actions={[
                  <Button
                    key="open"
                    type="primary"
                    icon={<ExportOutlined />}
                    loading={busy === item.repo}
                    onClick={() => open(item.repo)}
                  >
                    打开
                  </Button>,
                ]}
              >
                <List.Item.Meta
                  title={
                    <Space size={8}>
                      <Typography.Text strong title={item.repo}>
                        {shortName(item.repo)}
                      </Typography.Text>
                      {item.last_used_at ? <Tag color="green">最近用过</Tag> : null}
                    </Space>
                  }
                  description={`最近使用：${fmtTime(item.last_used_at ?? item.bound_at)}`}
                />
              </List.Item>
            )}
          />
        )}
      </Card>

      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        如果打开后提示连不上仓库（例如在 GitHub 上卸载过 App），按设计器里的提示重新连接即可。
      </Typography.Text>
    </Space>
  );
}
