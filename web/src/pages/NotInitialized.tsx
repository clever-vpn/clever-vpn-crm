import { Button, Result } from "antd";

/**
 * SaaS 分片的"尚未初始化"页。
 *
 * 什么时候出现：租户库存在、但里面**没有管理员**（数据恢复 / 库被重建 / 开通中断）。
 * 这时不能走自托管的一次性 `SETUP_TOKEN` 初始化 —— 那不是租户能做的事，也不该让
 * 租户看到部署期概念。平台侧补种后刷新即可。
 */
export default function NotInitialized({ onRetry }: { onRetry: () => void }) {
  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24 }}>
      <Result
        status="info"
        title="站点尚未完成初始化"
        subTitle="该站点的管理员账号还没有准备好。请联系平台支持，处理完成后刷新本页即可登录。"
        extra={
          <Button type="primary" onClick={onRetry}>
            刷新
          </Button>
        }
      />
    </div>
  );
}
