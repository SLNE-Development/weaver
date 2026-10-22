import type { Metadata } from "next";
import { headers } from "next/headers";
import { CircleAlertIcon, TriangleAlertIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@weaver/ui/components/alert";
import { AuthFrame } from "@/components/auth-frame";
import { FormatBadge, KindLabel } from "@/app/(app)/repositories/_components/format-badge";
import { requestIp } from "@weaver/npm";
import { compareClients, defaultCliLoginForm, loadCliLogin, type ClientMatch } from "@/server/cli-login";
import { getServerContext } from "@/server/context";
import { requireRole } from "@/server/session";
import { browsableRepositories } from "@/server/trpc/helpers";
import { CliLoginForm } from "./cli-login-form";

export const metadata: Metadata = { title: "Authorize npm login", robots: { index: false, follow: false } };

const dateFormat = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "medium", timeZone: "UTC" });

/** The warning above the form, stronger when the login came from another address than this browser's. */
const WARNING: Record<ClientMatch, { destructive: boolean; title: string; text: string }> = {
  same: {
    destructive: false,
    title: "Only continue if you just ran npm login yourself",
    text: "Check that the repository, the start time and the requesting client match the command you ran. If someone sent you this link, deny it: whoever started the login receives the token.",
  },
  different: {
    destructive: true,
    title: "This login was started from a different address than yours",
    text: "If you did not just run npm login on another machine you control, deny it: whoever started the login receives the token. Write access is not pre-selected.",
  },
  unknown: {
    destructive: false,
    title: "Only continue if you just ran npm login yourself",
    text: "Weaver could not compare the requesting client's address with yours. If someone sent you this link, deny it: whoever started the login receives the token. Write access is not pre-selected.",
  },
};

/**
 * The page `npm login` opens in the browser (signed-in only): shows which npm repository the login
 * targets, when and from which address and user agent the CLI started it next to the browser's own
 * address (with a stronger warning and read-only defaults when they differ), and lets the user create a token with chosen permissions for
 * the waiting CLI, or deny the login.
 */
export default async function CliLoginPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, principal } = await requireRole("viewer", `/cli-login/${encodeURIComponent(id)}`);
  const { db } = getServerContext();
  const view = await loadCliLogin(db, id);

  if (view.state === "gone") {
    return (
      <AuthFrame title="Authorize npm login" description="This login link can't be used.">
        <Alert variant="destructive" data-testid="cli-login-gone">
          <CircleAlertIcon />
          <AlertTitle>Login link expired</AlertTitle>
          <AlertDescription>This login link has expired. Run npm login again.</AlertDescription>
        </Alert>
      </AuthFrame>
    );
  }

  const repositories = (await browsableRepositories(db, principal)).map(({ name, format, kind }) => ({ name, format, kind }));
  const approverIp = requestIp(await headers());
  const clients = compareClients(view.requester.ip, approverIp);
  const defaults = defaultCliLoginForm(view.repository.name, user.role, new Date(), view.repository.kind, clients);
  const warning = WARNING[clients];

  return (
    <AuthFrame
      wide
      title="Authorize npm login"
      description={
        <>
          A command line client asks for a Weaver token on your behalf, signed in as <strong>{user.name}</strong>.
        </>
      }
      footer={
        <>
          The token is handed to the waiting terminal once and is listed under API keys, where you can revoke it. This link
          expires at <time dateTime={view.expiresAt.toISOString()}>{dateFormat.format(view.expiresAt)} UTC</time>.
        </>
      }
    >
      <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-6 gap-y-3 rounded-md border bg-surface p-4 text-sm">
        <dt className="text-muted-foreground">Client</dt>
        <dd>npm login (npm, pnpm, yarn or bun)</dd>
        <dt className="text-muted-foreground">Repository</dt>
        <dd className="flex flex-wrap items-center gap-2" data-testid="cli-login-repository">
          <FormatBadge format={view.repository.format} />
          <span className="font-mono">{view.repository.name}</span>
          <KindLabel kind={view.repository.kind} />
        </dd>
        <dt className="text-muted-foreground">Started</dt>
        <dd>
          <time dateTime={view.createdAt.toISOString()} data-testid="cli-login-created">
            {dateFormat.format(view.createdAt)} UTC
          </time>
        </dd>
        <dt className="text-muted-foreground">Requested from</dt>
        <dd className="break-words" data-testid="cli-login-requester">
          <span className="font-mono">{view.requester.ip ?? "unknown address"}</span>{" "}
          <span className="text-muted-foreground">({view.requester.userAgent ?? "no user agent"})</span>
        </dd>
        <dt className="text-muted-foreground">Your address</dt>
        <dd className="font-mono" data-testid="cli-login-approver">
          {approverIp ?? "unknown"}
        </dd>
      </dl>
      <Alert variant={warning.destructive ? "destructive" : "default"} data-testid="cli-login-warning" data-clients={clients}>
        <TriangleAlertIcon />
        <AlertTitle>{warning.title}</AlertTitle>
        <AlertDescription>{warning.text}</AlertDescription>
      </Alert>
      <CliLoginForm id={id} defaults={defaults} repositories={repositories} role={user.role} />
    </AuthFrame>
  );
}
