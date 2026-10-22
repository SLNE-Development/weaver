import type { Metadata } from "next";
import { headers } from "next/headers";
import { Avatar, AvatarFallback, AvatarImage } from "@weaver/ui/components/avatar";
import { Badge } from "@weaver/ui/components/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@weaver/ui/components/card";
import { getEnabledSocialProviders } from "@/server/auth";
import { getServerContext } from "@/server/context";
import { requireRole } from "@/server/session";
import { ConnectedAccounts } from "./connected-accounts";

export const metadata: Metadata = { title: "Account" };

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** The signed-in user's profile and the OAuth accounts they can sign in with. */
export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { user } = await requireRole("viewer", "/account");
  const [accounts, params] = await Promise.all([
    getServerContext().auth.api.listUserAccounts({ headers: await headers() }),
    searchParams,
  ]);
  const linked = accounts.map((account) => ({ id: account.id, providerId: account.providerId }));

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-lg font-semibold tracking-tight">Account</h1>
        <p className="text-sm text-muted-foreground">Your profile and the accounts you sign in with.</p>
      </div>

      <Card className="gap-4 rounded-md py-4 shadow-none">
        <CardHeader className="px-4">
          <CardTitle className="text-sm">Profile</CardTitle>
        </CardHeader>
        <CardContent className="flex items-center gap-4 px-4">
          <Avatar size="lg" className="rounded-md">
            {user.image && <AvatarImage src={user.image} alt="" />}
            <AvatarFallback className="rounded-md">{user.name.slice(0, 2).toUpperCase()}</AvatarFallback>
          </Avatar>
          <div className="grid min-w-0 flex-1 gap-0.5">
            <span className="truncate font-medium">{user.name}</span>
            <span className="truncate text-sm text-muted-foreground">{user.email}</span>
          </div>
          <Badge variant="outline" className="font-mono">
            {user.role}
          </Badge>
        </CardContent>
      </Card>

      <Card className="gap-4 rounded-md py-4 shadow-none">
        <CardHeader className="px-4">
          <CardTitle className="text-sm">Connected accounts</CardTitle>
          <CardDescription>
            You can sign in with any connected account. Connect one here before using it to sign in.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          <ConnectedAccounts providers={getEnabledSocialProviders()} linked={linked} error={first(params.error) ?? null} />
        </CardContent>
      </Card>
    </div>
  );
}
