import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// React 19 上 antd v5 的静态方法（message/Modal）与波纹动画需要这个补丁
import "@ant-design/v5-patch-for-react-19";
import { App as AntApp, ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";
import App from "./App";
import { antdTheme } from "./antd-theme";
// 迁移期保留：还没换到 antd 的页面（套餐/设置）仍用这里的类名，迁完即删。
import "./theme.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ConfigProvider locale={zhCN} theme={antdTheme}>
      <AntApp>
        <App />
      </AntApp>
    </ConfigProvider>
  </StrictMode>,
);
