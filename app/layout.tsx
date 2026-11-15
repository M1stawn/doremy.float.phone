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
    // 1. 拦截 attachShadow：只要 Netlify 徽章试图创建 Shadow DOM 黑盒，当场废掉它的宿主元素
    var origAttach = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function(init) {
      var shadow = origAttach.call(this, { mode: 'open' });
      var host = this;
      setTimeout(function() {
        var html = (shadow.innerHTML || '') + (host.outerHTML || '');
        if (/netlify/i.test(html)) {
          host.style.setProperty('display', 'none', 'important');
          host.remove();
        }
      }, 0);
      return shadow;
    };

    // 2. 扫描页面上所有非小手机本体（非 #__next）的顶层节点与悬浮元素
    function killPoweredByBadge() {
      // 小手机的所有正常界面全在 body 下的主容器里，凡是额外挂在 body 下的 Netlify 节点一律干掉
      document.querySelectorAll('body > *').forEach(function(el) {
        if (el.id === '__next' || el.tagName === 'SCRIPT' || el.tagName === 'STYLE') return;
        var content = (el.outerHTML || '') + (el.innerText || '') + (el.shadowRoot ? el.shadowRoot.innerHTML : '');
        var style = window.getComputedStyle(el);
        // 只要包含 netlify 字样，或者是固定在屏幕角落的高层级悬浮块
        if (/netlify/i.test(content) || (style.position === 'fixed' && parseInt(style.zIndex || '0', 10) > 99999)) {
          el.style.setProperty('display', 'none', 'important');
          el.style.setProperty('visibility', 'hidden', 'important');
          el.style.setProperty('opacity', '0', 'important');
          el.style.setProperty('pointer-events', 'none', 'important');
          el.remove();
        }
      });

      // 兜底：遍历页面上所有带链接或 ShadowRoot 的节点
      document.querySelectorAll('a[href*="netlify"], [class*="netlify"], [id*="netlify"], iframe[src*="netlify"]').forEach(function(el) {
        var box = el.closest('div[style*="fixed"]') || el.parentElement || el;
        if (box && box !== document.body && box.id !== '__next') {
          box.style.setProperty('display', 'none', 'important');
          box.remove();
        }
      });
    }

    killPoweredByBadge();
    new MutationObserver(killPoweredByBadge).observe(document.documentElement, { childList: true, subtree: true });
    setInterval(killPoweredByBadge, 300);
  })();
` }} />
      </body>
    </html>
  );
}
