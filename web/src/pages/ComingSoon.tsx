/**
 * 「这一块还没做」的统一页面
 *
 * 存在的意义：菜单可以按最终形态排好（让租户一眼看到营销有哪几件工具），
 * 但点进去必须**如实说没做**，而不是摆一个空表格假装能用。
 */

export default function ComingSoon({
  title,
  intro,
  bullets,
  stage,
}: {
  title: string;
  intro: string;
  bullets: string[];
  /** 对应 `docs/promotion.md` 的排期 */
  stage: string;
}) {
  return (
    <div className="stack">
      <div className="card">
        <div className="row between">
          <h3>{title}</h3>
          <span className="tag tag-draft">未上线</span>
        </div>
        <p className="hint">{intro}</p>

        <h4 style={{ marginTop: 16 }}>上线后会有什么</h4>
        <ul className="hint" style={{ margin: 0, paddingLeft: 18 }}>
          {bullets.map((b) => (
            <li key={b} style={{ marginBottom: 4 }}>
              {b}
            </li>
          ))}
        </ul>

        <div className="notice info" style={{ marginTop: 16 }}>
          排期：{stage}。设计依据见仓库 <span className="mono">docs/promotion.md</span>。
        </div>
      </div>
    </div>
  );
}
