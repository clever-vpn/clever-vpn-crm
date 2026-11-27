/**
 * 应用：打开 App 设计器。
 *
 * 这一页只有一件事：**选一个 App → 打开设计器**（一个 GitHub 项目 = 一个 App =
 * 一份草稿，`decisions-amend-4` / `-5`）。所以它不展示分支 / PR / 版本 —— 那些都在
 * 设计器里，CRM 也不知道。
 *
 * 对外用词是 **App / 项目**，不是"仓库"：租户不需要知道 Git 的概念。
 * 行首仍然显示 `账号 / 项目名` —— 同名项目来自不同账号时必须能区分（这是唯一
 * 展示账号的地方，安装页里他也见过）。
 *
 * 三种状态：
 *   · 列表为空        → 只有「新建 App」（= 不带 repo 打开 studio，由 studio 引导授权）
 *   · 有 App          → 每行一个「打开」，带 repo 取票
 *   · 打开失败        → 说清是"没配地址"还是"studio 不可达"，不吞错误
 */
import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Button,
  Card,
  Empty,
  List,
  Popconfirm,
  Space,
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

/** `acme/my-vpn` → `{ owner: 'acme', name: 'my-vpn' }` */
const splitRepo = (repo: string): { owner: string; name: string } => {
  const at = repo.indexOf("/");
  return at < 0 ? { owner: "", name: repo } : { owner: repo.slice(0, at), name: repo.slice(at + 1) };
};

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

  /** 只从面板移除：GitHub 项目与设计器草稿都不动（契约里写死了这条） */
  async function remove(repo: string) {
    setBusy(`remove:${repo}`);
    try {
      await api.removeApp(repo);
      message.success("已从列表移除");
      await load();
    } catch (e) {
      message.error(e instanceof ApiError ? e.message : "移除失败");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Card title="应用">
        <Typography.Paragraph style={{ marginBottom: 8 }}>
          每个 App 对应 GitHub 上的一个项目。选一个打开设计器：文案、配色、页面都在那里改，
          改完点「发布」，安装包也会出现在设计器里。
        </Typography.Paragraph>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          第一次使用需要授权一次（约 10 秒）；之后从这一页打开就行。
        </Typography.Paragraph>
      </Card>

      {error ? <Alert type="warning" showIcon message={error} /> : null}

      <Card>
        {repos === null ? (
          <Typography.Text type="secondary">读取中…</Typography.Text>
        ) : (
          <>
            {repos.length === 0 ? (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={
                  <span>
                    还没有 App。
                    <br />
                    点下面的「新建 App」开始，设计器会引导你完成一次授权。
                  </span>
                }
              />
            ) : (
              <List
                dataSource={repos}
                renderItem={(item) => {
                  const { owner, name } = splitRepo(item.repo);
                  return (
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
                        <Popconfirm
                          key="remove"
                          title={`从面板移除「${name}」？`}
                          description={
                            <span>
                              设计器里未发布的改动会保留；GitHub 上的项目不会被删除。
                              之后可以随时重新连接。
                            </span>
                          }
                          okText="移除"
                          okButtonProps={{ danger: true }}
                          cancelText="取消"
                          onConfirm={() => remove(item.repo)}
                        >
                          <Button danger type="text" loading={busy === `remove:${item.repo}`}>
                            移除
                          </Button>
                        </Popconfirm>,
                      ]}
                    >
                      <List.Item.Meta
                        title={
                          <span title={item.repo}>
                            <Typography.Text type="secondary">{owner} / </Typography.Text>
                            <Typography.Text strong>{name}</Typography.Text>
                          </span>
                        }
                        description={`最近使用：${fmtTime(item.last_used_at ?? item.bound_at)}`}
                      />
                    </List.Item>
                  );
                }}
              />
            )}

            {/* 「新建」是列表的最后一行，和「打开」同一形态 —— 不是标题栏上的同级按钮 */}
            <Button
              type="dashed"
              block
              icon={<AppstoreAddOutlined />}
              loading={busy === "new"}
              onClick={() => open()}
              style={{ marginTop: repos.length ? 8 : 16 }}
            >
              新建 App
            </Button>
          </>
        )}
      </Card>

      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        如果打开后提示这个 App 的项目连不上（例如在 GitHub 上撤销过授权），按设计器里的提示重新连接即可。
      </Typography.Text>
    </Space>
  );
}
