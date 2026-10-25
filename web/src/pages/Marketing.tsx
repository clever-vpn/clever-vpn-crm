/**
 * 营销总览 —— 「我有哪些促销工具」的唯一答案页
 *
 * 这一页只做两件事：讲清三类工具的分工，给出当前活动的几个硬数字。
 * 真正的规则在 `src/promotions/*`，这里不重复实现任何判断。
 */

import { useEffect, useState } from "react";

import { api, ApiError, type PromotionView } from "../api";

interface Tool {
  name: string;
  effect: string;
  what: string;
  bullets: string[];
  href: string;
  ready: boolean;
}

const TOOLS: Tool[] = [
  {
    name: "优惠券",
    effect: "改订单金额",
    what: "让这一单少付钱。应付变小，未来残值也跟着变小。",
    bullets: ["自动生效（打开就看见，不用码）", "凭码使用（投放给渠道 / 群 / 博主）", "人群：新人 / 老客 / 快到期 / 点名"],
    href: "/admin/marketing/coupons",
    ready: true,
  },
  {
    name: "礼包",
    effect: "改订阅权益",
    what: "钱不变，白送天数或流量。折扣与赠送分开记账，残值不受影响。",
    bullets: ["送天数 / 送流量 / 重置本月已用", "注册即送（首单开通后自动发）", "到期前自动送（挽回）/ 手动发给指定客户"],
    href: "/admin/marketing/gifts",
    ready: true,
  },
  {
    name: "邀请返利",
    effect: "建立归因",
    what: "唯一能回答「谁拉来的」的东西。被邀请人拿首单权益，邀请人拿权益。",
    bullets: ["邀请码选填，永不强制", "双向奖励：天数 / 流量", "不做佣金提现"],
    href: "/admin/marketing/referrals",
    ready: true,
  },
];

function yuan(minor: number): string {
  return (minor / 100).toFixed(2);
}

export default function Marketing() {
  const [items, setItems] = useState<PromotionView[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await api.promotions();
        if (alive) setItems(r.promotions);
      } catch (e) {
        if (alive) setError(e instanceof ApiError ? e.message : "加载失败");
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const active = items.filter((p) => p.status === "active");
  const drafts = items.filter((p) => p.status === "draft");
  const uses = items.reduce((sum, p) => sum + (p.uses ?? 0), 0);
  // 让利 = 每次核销的实际减免之和（amount 直接相加；percent 按"平均一单"无法还原，单独标注）
  const amountOff = items
    .filter((p) => p.benefit_type === "amount")
    .reduce((sum, p) => sum + p.benefit_value * (p.uses ?? 0), 0);

  return (
    <div className="stack">
      <div className="card">
        <h3>营销总览</h3>
        <p className="hint">
          三件工具，作用点不同：<b>优惠券</b>改钱、<b>礼包</b>改权益、<b>邀请返利</b>建关系。
          同一套规则引擎，后台算出的结果与 App / 官网必然一致。
        </p>

        <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }}>
          {TOOLS.map((t) => (
            <div className="card" key={t.name} style={{ margin: 0 }}>
              <div className="row between">
                <h3 style={{ margin: 0 }}>{t.name}</h3>
                <span className={`tag ${t.ready ? "tag-active" : "tag-dim"}`}>{t.ready ? "可用" : "待上线"}</span>
              </div>
              <p className="hint" style={{ marginTop: 4 }}>
                <b>{t.effect}</b> —— {t.what}
              </p>
              <ul className="hint" style={{ margin: "8px 0 0", paddingLeft: 18 }}>
                {t.bullets.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
              <div className="actions" style={{ marginTop: 10 }}>
                <a href={t.href}>{t.ready ? "去管理" : "看计划"}</a>
              </div>
            </div>
          ))}
        </div>
      </div>

      {error && <div className="notice error">{error}</div>}

      <div className="card">
        <h3>当前状态</h3>
        <div className="grid">
          <div>
            <div className="hint">进行中的活动</div>
            <strong style={{ fontSize: 22 }}>{active.length}</strong>
          </div>
          <div>
            <div className="hint">草稿</div>
            <strong style={{ fontSize: 22 }}>{drafts.length}</strong>
          </div>
          <div>
            <div className="hint">累计核销</div>
            <strong style={{ fontSize: 22 }}>{uses}</strong>
          </div>
          <div>
            <div className="hint">满减型累计让利</div>
            <strong style={{ fontSize: 22 }}>¥{yuan(amountOff)}</strong>
            <div className="hint">比例型不好还原，未计入</div>
          </div>
        </div>
        <p className="hint" style={{ marginTop: 10 }}>
          核销数是「已支付订单上的使用次数」——下单不算、退款会标记作废。更细的按活动效果报表还在
          <a href="/admin/marketing/report"> 营销报表</a>（未上线）。
        </p>
      </div>
    </div>
  );
}
