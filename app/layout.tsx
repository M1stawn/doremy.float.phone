import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import { ChatPluginBootstrap } from "@/components/chat-plugin-bootstrap";
import { ChatReasoningVisibilityController } from "@/components/chat-reasoning-visibility-controller";
import { CSSImportEnhancer } from "@/components/css-import-enhancer";
import { PWAManifestInjector } from "@/components/pwa-manifest-injector";
import { PWARegistrar } from "@/components/pwa-registrar";
import { DeviceCompatibilityBootstrap } from "@/components/device-compatibility-bootstrap";
import { GlobalNoticeHost } from "@/components/ui/global-notice-host";
import "../styles/fonts.css";
import "./globals.css";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  // Android 键盘弹出时让浏览器原生压缩布局视口（而非只压缩 visualViewport）。
  // 配合 desktop-shell 的 --phone-screen-height 同步：输入栏天然贴在键盘上方，
  // 点击命中区域由原生布局保证，彻底避免手动抬升带来的视觉/hit-test 错位。
  interactiveWidget: "resizes-content",
};

export const metadata: Metadata = {
  title: "float",
  description: "float",
};

export default function RootLayout({
  children
}: Readonly<{
  children: ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <head>
        <link rel="manifest" href="/manifest.webmanifest" crossOrigin="use-credentials" />
        <meta name="theme-color" content="#f8f7f2" />
        <link rel="apple-touch-icon" href="/icon-192.png" />
        <link rel="icon" href="/icon-192.png" type="image/png" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-title" content="float" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="mobile-web-app-capable" content="yes" />
      </head>
      <body>
        <PWAManifestInjector />
        <PWARegistrar />
        <DeviceCompatibilityBootstrap />
        <CSSImportEnhancer />
        <ChatPluginBootstrap />
        <ChatReasoningVisibilityController />
        <GlobalNoticeHost />
        {children}
<script dangerouslySetInnerHTML={{ __html: `
  (function() {
    // 1. 拦截 Shadow DOM：只有里面真的写了 netlify 才动手，绝不误伤正常组件
    var origAttach = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function(init) {
      var shadow = origAttach.call(this, { mode: 'open' });
      var host = this;
      setTimeout(function() {
        var html = (shadow.innerHTML || '') + (host.outerHTML || '');
        if (/netlify\\.com|powered by netlify|deployed on netlify/i.test(html)) {
          host.style.setProperty('display', 'none', 'important');
          host.remove();
        }
      }, 0);
      return shadow;
    };

    // 2. 精准点杀：只删包含 netlify 特征的节点，彻底放行小手机自己的弹窗与浮窗
    function killOnlyNetlify() {
      // 直接抓带 netlify 属性、标签或外链的元素
      document.querySelectorAll(
        'netlify-badge, [data-netlify-deploy-id], .netlify-badge, #netlify-badge, a[href*="netlify.com"], iframe[src*="netlify"]'
      ).forEach(function(el) {
        // 只往上找一层固定定位的小外框，绝不往上删到主页面容器
        var wrapper = el.closest('[data-netlify-deploy-id], netlify-badge') || el.parentElement;
        if (wrapper && wrapper !== document.body && wrapper.children.length <= 2 && /netlify/i.test(wrapper.innerHTML)) {
          wrapper.style.setProperty('display', 'none', 'important');
          wrapper.remove();
        } else {
          el.style.setProperty('display', 'none', 'important');
          el.remove();
        }
      });

      // 检查挂在 body 下带 open ShadowRoot 的野生宿主
      document.querySelectorAll('body > *').forEach(function(el) {
        if (el.shadowRoot && /netlify\\.com|powered by netlify/i.test(el.shadowRoot.innerHTML || '')) {
          el.style.setProperty('display', 'none', 'important');
          el.remove();
        }
      });
    }

    killOnlyNetlify();
    new MutationObserver(killOnlyNetlify).observe(document.documentElement, { childList: true, subtree: true });
    setInterval(killOnlyNetlify, 500);
  })();
` }} />
      </body>
    </html>
  );
}
