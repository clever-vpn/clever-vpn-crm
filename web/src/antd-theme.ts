import type { ThemeConfig } from "antd";

/**
 * 管理后台主题（antd Design Token）
 *
 * 全站**只在这里定义颜色/圆角/控件高度**，页面里禁止出现裸色值。
 * 换主色 = 改 `brand` 这一行。
 */
const brand = "#6d4aff";

export const antdTheme: ThemeConfig = {
  token: {
    colorPrimary: brand,
    colorLink: brand,
    borderRadius: 8,
    // 手机端要 ≥40px 才点得准；桌面 32 太挤。统一 36，小尺寸控件用 size="small" 单独收。
    controlHeight: 36,
    fontSize: 14,
    colorBgLayout: "#f5f6fa",
    colorTextBase: "#1f2333",
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
    wireframe: false,
  },
  components: {
    Layout: {
      // 深色侧栏（泡泡支付那种"左深右浅"）
      siderBg: "#1b2337",
      triggerBg: "#141a2b",
      headerBg: "#ffffff",
      headerHeight: 56,
      headerPadding: "0 20px",
      bodyBg: "#f5f6fa",
    },
    Menu: {
      darkItemBg: "transparent",
      darkSubMenuItemBg: "transparent",
      darkItemSelectedBg: "#2a3550",
      darkItemColor: "#c7cedd",
      darkItemHoverBg: "#242e45",
      darkItemSelectedColor: "#ffffff",
      itemHeight: 40,
      itemMarginInline: 8,
    },
    Table: {
      headerBg: "#fafbfd",
      headerSplitColor: "transparent",
      rowHoverBg: "#fafbfd",
      cellPaddingBlock: 12,
    },
    Card: {
      paddingLG: 20,
    },
    Button: {
      // 主按钮在手机上要够大
      controlHeightLG: 44,
      fontWeight: 500,
    },
    Segmented: {
      itemSelectedBg: "#ffffff",
    },
  },
};
