"use client";

import { useState, useTransition } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { CircleAlertIcon, CircleCheckIcon, CircleXIcon } from "lucide-react";
import type { Role } from "@weaver/core";
import { Alert, AlertDescription, AlertTitle } from "@weaver/ui/components/alert";
import { Button } from "@weaver/ui/components/button";
import { Form } from "@weaver/ui/components/form";
import { Spinner } from "@weaver/ui/components/spinner";
import { KeyFormFields, type KeyFormRepository } from "@/components/manage/key-form-fields";
import { keyFormSchema, type KeyFormValues } from "@/lib/api-keys";
import { approveCliLoginAction, denyCliLoginAction } from "./actions";

/**
 * The key form of the npm login page, pre-filled with `defaults`: "Create token" approves the login
 * session `id` with a key built from the form, "Deny" refuses it. Afterwards only the outcome is shown;
 * the token itself goes to the terminal, never to this page.
 */
export function CliLoginForm({
  id,
  defaults,
  repositories,
  role,
}: {
  id: string;
  defaults: KeyFormValues;
  repositories: KeyFormRepository[];
  role: Role;
}) {
  const form = useForm<KeyFormValues>({ resolver: zodResolver(keyFormSchema), defaultValues: defaults });
  const [outcome, setOutcome] = useState<"approved" | "denied" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [action, setAction] = useState<"approve" | "deny" | null>(null);

  function run(kind: "approve" | "deny", call: () => ReturnType<typeof denyCliLoginAction>) {
    setAction(kind);
    setError(null);
    startTransition(async () => {
      try {
        const result = await call();
        if (result.ok) setOutcome(kind === "approve" ? "approved" : "denied");
        else setError(result.error);
      } catch {
        setError("Something went wrong. Try again.");
      }
    });
  }

  if (outcome === "approved") {
    return (
      <Alert data-testid="cli-login-done">
        <CircleCheckIcon />
        <AlertTitle>Token created</AlertTitle>
        <AlertDescription>Token created. You can close this tab and return to your terminal.</AlertDescription>
      </Alert>
    );
  }
  if (outcome === "denied") {
    return (
      <Alert data-testid="cli-login-denied">
        <CircleXIcon />
        <AlertTitle>Login denied</AlertTitle>
        <AlertDescription>No token was created. You can close this tab.</AlertDescription>
      </Alert>
    );
  }

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit((values) => run("approve", () => approveCliLoginAction(id, values)))}
        noValidate
        className="grid gap-5"
      >
        <KeyFormFields form={form} repositories={repositories} loading={false} role={role} autoFocusName={false} />
        {error && (
          <Alert variant="destructive">
            <CircleAlertIcon />
            <AlertTitle>Couldn&apos;t authorize npm login</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" disabled={pending} onClick={() => run("deny", () => denyCliLoginAction(id))}>
            {pending && action === "deny" && <Spinner />}
            Deny
          </Button>
          <Button type="submit" disabled={pending}>
            {pending && action === "approve" && <Spinner />}
            Create token
          </Button>
        </div>
      </form>
    </Form>
  );
}
