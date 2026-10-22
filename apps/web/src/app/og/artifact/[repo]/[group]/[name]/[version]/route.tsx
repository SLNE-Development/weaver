import { artifactCard, GENERIC_ARTIFACT_CARD, type ArtifactCardParams } from "@/lib/og-artifact";
import { ogPngResponse, renderOgPng } from "@/lib/og";
import { getServerContext } from "@/server/context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<ArtifactCardParams> };

/** The generic card never changes within a process: render it once. */
let genericPng: Promise<Uint8Array> | undefined;

function genericCardPng(): Promise<Uint8Array> {
  genericPng ??= renderOgPng(GENERIC_ARTIFACT_CARD).catch((error: unknown) => {
    genericPng = undefined;
    throw error;
  });
  return genericPng;
}

/**
 * Share card (PNG, 1200×630) of an artifact version; `version` may be `latest`. Private and unknown
 * artifacts get the generic Weaver card, served with the same status and headers as a real
 * card, so responses don't reveal which artifacts exist.
 */
export async function GET(_req: Request, { params }: Context): Promise<Response> {
  const card = await artifactCard(getServerContext().registry, await params);
  const png = card === GENERIC_ARTIFACT_CARD ? await genericCardPng() : await renderOgPng(card);
  return ogPngResponse(png);
}
