import { APP_NAME, GITHUB_REPO_URL, X_PROFILE_URL } from "../constants/app";

interface SiteContext {
  pageUrl: string;
  siteUrl: string;
}

export function buildOrganizationSchema({ siteUrl }: SiteContext) {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: APP_NAME,
    url: siteUrl,
    logo: `${siteUrl}/brand/icon.png`,
    sameAs: [X_PROFILE_URL, GITHUB_REPO_URL],
  };
}

export function buildWebsiteSchema({ siteUrl }: SiteContext) {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: APP_NAME,
    url: siteUrl,
    inLanguage: "en",
  };
}

export function buildSoftwareApplicationSchema({
  pageUrl,
  siteUrl,
}: SiteContext): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: APP_NAME,
    url: siteUrl,
    applicationCategory: "ProductivityApplication",
    operatingSystem: "macOS, Windows, Linux",
    applicationSubCategory: "AI Workspace",
    downloadUrl: `${siteUrl}/download/`,
    screenshot: `${siteUrl}/screenshots/bigbud.webp`,
    image: `${siteUrl}/social/bigbud-social-preview.png`,
    description:
      "bigbud is an AI workspace for everyone. It keeps research, writing, coding, files, and git workflows in one place so you can stay focused and get more done with less context switching.",
    offers: {
      "@type": "Offer",
      price: "0",
      priceCurrency: "USD",
      availability: "https://schema.org/InStock",
      url: `${siteUrl}/download/`,
    },
    creator: {
      "@type": "Organization",
      name: APP_NAME,
      url: siteUrl,
    },
    mainEntityOfPage: pageUrl,
  };
}

export function buildBreadcrumbSchema(pageUrl: string, pageName: string, siteUrl: string) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      {
        "@type": "ListItem",
        position: 1,
        name: "Home",
        item: siteUrl,
      },
      {
        "@type": "ListItem",
        position: 2,
        name: pageName,
        item: pageUrl,
      },
    ],
  };
}
