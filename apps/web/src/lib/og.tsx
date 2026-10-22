import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { instanceHost, OG_IMAGE_SIZE } from "./seo";

/** Share-card palette: the dark Ink theme. Shared by every card so landing, docs and artifacts match. */
export const OG_COLORS = {
  background: "#0a0a0a",
  text: "#ededed",
  muted: "#8f8f8f",
  hairline: "#262626",
  link: "#7aa2ff",
  release: "#4ade80",
  releaseSoft: "#0f2417",
  snapshot: "#f59e0b",
  snapshotSoft: "#2a1f0d",
} as const;

/**
 * The inverted Weaver icon (white tile, black threads), identical to
 * packages/ui/src/assets/weaver-icon-inverted.svg (a test keeps them in sync).
 */
export const LOGO_INVERTED_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64" role="img" aria-label="Weaver">
  <rect width="64" height="64" rx="16" fill="#ffffff"/>
  <path d="M20 13V51M32 13V51M44 13V51M13 20H51M13 32H51M13 44H51" fill="none" stroke="#000000" stroke-width="6" stroke-linecap="round"/>
  <path d="M20 14.25V25.75M14.25 32H25.75M20 38.25V49.75M26.25 20H37.75M32 26.25V37.75M26.25 44H37.75M44 14.25V25.75M38.25 32H49.75M44 38.25V49.75" fill="none" stroke="#ffffff" stroke-width="10.5"/>
  <path d="M20 13.25V26.75M13.25 32H26.75M20 37.25V50.75M25.25 20H38.75M32 25.25V38.75M25.25 44H38.75M44 13.25V26.75M37.25 32H50.75M44 37.25V50.75" fill="none" stroke="#000000" stroke-width="6"/>
</svg>`;

const LOGO_DATA_URI = `data:image/svg+xml;base64,${Buffer.from(LOGO_INVERTED_SVG).toString("base64")}`;

type FontWeight = 400 | 500 | 600;

interface OgFont {
  name: string;
  data: Buffer;
  weight: FontWeight;
  style: "normal";
}

// Static Geist / Geist Mono builds as .woff: the image renderer (Satori) reads neither woff2 nor
// variable fonts, which is all @fontsource-variable ships. Read from node_modules, never the network.
async function readFont(name: string, pkg: "geist" | "geist-mono", weight: FontWeight): Promise<OgFont> {
  const data = await readFile(
    join(process.cwd(), "node_modules", "@fontsource", pkg, "files", `${pkg}-latin-${weight}-normal.woff`),
  );
  return { name, data, weight, style: "normal" };
}

let fonts: Promise<OgFont[]> | undefined;

/** Loads the card fonts once per process. */
function loadFonts(): Promise<OgFont[]> {
  fonts ??= Promise.all([
    readFont("Geist", "geist", 400),
    readFont("Geist", "geist", 600),
    readFont("Geist Mono", "geist-mono", 400),
    readFont("Geist Mono", "geist-mono", 500),
  ]).catch((error: unknown) => {
    fonts = undefined;
    throw error;
  });
  return fonts;
}

export interface OgCardInput {
  /** Small uppercase mono line above the title, e.g. "Docs · Clients". */
  eyebrow: string;
  title: string;
  subtitle?: string;
  /** Render the subtitle in Geist Mono (coordinates). */
  subtitleMono?: boolean;
  /** Left side of the footer row; defaults to the instance host. */
  footer?: string;
  /** Pill next to the eyebrow, e.g. Release / Snapshot. */
  badge?: { label: string; tone: "release" | "snapshot" };
  /** Short facts on the right of the footer row, e.g. ["3 files", "1 dependency"]. */
  meta?: string[];
}

function titleSize(title: string): number {
  if (title.length <= 26) return 80;
  if (title.length <= 44) return 66;
  return 54;
}

/** The share-card layout (1200×630): logo, eyebrow, title, subtitle, footer with host and facts. */
export function OgCard({ eyebrow, title, subtitle, subtitleMono, footer, badge, meta }: OgCardInput & { footer: string }) {
  const badgeColors =
    badge?.tone === "snapshot"
      ? { color: OG_COLORS.snapshot, background: OG_COLORS.snapshotSoft }
      : { color: OG_COLORS.release, background: OG_COLORS.releaseSoft };
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        padding: 64,
        backgroundColor: OG_COLORS.background,
        // A hairline grid that fades in towards the right, behind the text it stays out of the way.
        backgroundImage: [
          `linear-gradient(90deg, ${OG_COLORS.background} 40%, rgba(10, 10, 10, 0.55) 100%)`,
          `linear-gradient(${OG_COLORS.hairline} 1px, transparent 1px)`,
          `linear-gradient(90deg, ${OG_COLORS.hairline} 1px, transparent 1px)`,
        ].join(", "),
        backgroundSize: "100% 100%, 48px 48px, 48px 48px",
        backgroundPosition: "0 0, -1px -1px, -1px -1px",
        color: OG_COLORS.text,
        fontFamily: "Geist",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
        <img src={LOGO_DATA_URI} width={72} height={72} alt="" />
        <div style={{ display: "flex", fontSize: 34, fontWeight: 600, letterSpacing: "-0.02em" }}>Weaver</div>
      </div>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          marginTop: "auto",
          maxWidth: 1072,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 22 }}>
          <div
            style={{
              display: "block",
              flexShrink: 1,
              overflow: "hidden",
              whiteSpace: "nowrap",
              textOverflow: "ellipsis",
              fontFamily: "Geist Mono",
              fontWeight: 500,
              fontSize: 22,
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              color: OG_COLORS.muted,
            }}
          >
            {eyebrow}
          </div>
          {badge && (
            <div
              style={{
                display: "flex",
                flexShrink: 0,
                whiteSpace: "nowrap",
                fontFamily: "Geist Mono",
                fontWeight: 500,
                fontSize: 20,
                padding: "4px 14px",
                borderRadius: 999,
                color: badgeColors.color,
                backgroundColor: badgeColors.background,
              }}
            >
              {badge.label}
            </div>
          )}
        </div>
        <div
          style={{
            display: "block",
            lineClamp: 2,
            fontSize: titleSize(title),
            fontWeight: 600,
            lineHeight: 1.06,
            letterSpacing: "-0.025em",
          }}
        >
          {title}
        </div>
        {subtitle && (
          <div
            style={{
              display: "block",
              lineClamp: 2,
              marginTop: 24,
              fontSize: subtitleMono ? 28 : 30,
              lineHeight: 1.4,
              color: subtitleMono ? OG_COLORS.link : OG_COLORS.muted,
              fontFamily: subtitleMono ? "Geist Mono" : "Geist",
            }}
          >
            {subtitle}
          </div>
        )}
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginTop: 40,
          paddingTop: 28,
          borderTop: `1px solid ${OG_COLORS.hairline}`,
          fontFamily: "Geist Mono",
          fontSize: 22,
          color: OG_COLORS.muted,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ display: "flex", width: 10, height: 10, borderRadius: 999, backgroundColor: OG_COLORS.release }} />
          {footer}
        </div>
        <div style={{ display: "flex", gap: 28 }}>
          {(meta ?? ["Maven · npm · Docker · proto"]).map((item) => (
            <div key={item} style={{ display: "flex", color: meta ? OG_COLORS.text : OG_COLORS.muted }}>
              {item}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Default `Cache-Control` of share cards: short, because titles, versions and visibility change. */
export const OG_CACHE_CONTROL = "public, max-age=300, s-maxage=300";

/**
 * Renders a share card as a PNG response with a short `Cache-Control` (next/og would default to
 * a year, immutable). `headers` overrides or adds headers.
 */
export async function renderOgCard(input: OgCardInput, init: { headers?: Record<string, string> } = {}): Promise<ImageResponse> {
  return new ImageResponse(<OgCard {...input} footer={input.footer ?? instanceHost()} />, {
    ...OG_IMAGE_SIZE,
    fonts: await loadFonts(),
    headers: { "cache-control": OG_CACHE_CONTROL, ...init.headers },
  });
}

/** The PNG bytes of a share card. */
export async function renderOgPng(input: OgCardInput): Promise<Uint8Array> {
  return new Uint8Array(await (await renderOgCard(input)).arrayBuffer());
}

/** A PNG response with exactly these headers, so every card a route serves looks the same on the wire. */
export function ogPngResponse(png: Uint8Array, cacheControl: string = OG_CACHE_CONTROL): Response {
  return new Response(png.slice(), {
    status: 200,
    headers: { "content-type": "image/png", "content-length": String(png.byteLength), "cache-control": cacheControl },
  });
}
