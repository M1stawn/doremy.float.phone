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
      <style dangerouslySetInnerHTML={{ __html: `
  netlify-badge,
  [data-netlify-deploy-id],
  .netlify-badge,
  #netlify-badge,
  a[href*="netlify.com"],
  iframe[src*="netlify"],
  div[style*="z-index: 2147483647"] {
    display: none !important;
    visibility: hidden !important;
    opacity: 0 !important;
    pointer-events: none !important;
    clip: rect(0, 0, 0, 0) !important;
    height: 0 !important;
    width: 0 !important;
    position: absolute !important;
    top: -9999px !important;
  }
` }} />
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
    var observer = new MutationObserver(function(mutations) {
      var badges = document.querySelectorAll('netlify-badge, [data-netlify-deploy-id], a[href*="netlify.com"], iframe[src*="netlify"]');
      badges.forEach(function(el) {
        var host = el.closest('div[style*="position: fixed"]') || el;
        host.remove();
      });
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  })();
` }} />
      </body>
    </html>
  );
}
