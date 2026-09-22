import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Flourish",
    short_name: "Flourish",
    description: "Expenses, spending patterns, savings, loans, cards, and investments",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait-primary",
    background_color: "#f7faf7",
    theme_color: "#214f3d",
    categories: ["finance", "productivity"],
    icons: [
      { src: "/icons/flourish-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/flourish-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/flourish-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" }
    ]
  };
}
