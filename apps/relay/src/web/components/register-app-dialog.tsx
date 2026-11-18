import { CircleAlertIcon, PlusIcon } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Alert, AlertDescription } from "@exterior/ui/alert";
import { Button } from "@exterior/ui/button";
import { CopyButton } from "@exterior/ui/copy-button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@exterior/ui/dialog";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@exterior/ui/field";
import { Input } from "@exterior/ui/input";

const appSetupGuide = "https://github.com/lulu0119/exterior/blob/main/docs/app-setup.md";
const clientIdGuide = "https://github.com/lulu0119/exterior/blob/main/packages/sdk/README.md#which-client-id";

type Registered = { clientName: string; configuration: string };

/** The same registration a coding assistant's setup link makes. */
export function RegisterAppDialog() {
  const [open, setOpen] = useState(false);
  const [clientName, setClientName] = useState("");
  const [redirectUri, setRedirectUri] = useState("");
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState("");
  const [registered, setRegistered] = useState<Registered>();

  function changeOpen(next: boolean) {
    if (pending) return;
    setOpen(next);
    // A finished registration starts the next one empty; an unfinished one keeps what was typed.
    if (!next && registered) {
      setRegistered(undefined);
      setClientName("");
      setRedirectUri("");
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setProblem("");
    try {
      const response = await fetch("/api/clients/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientName, redirectUris: [redirectUri.trim()], confidential: false }),
        signal: AbortSignal.timeout(10_000),
      });
      if (response.status === 401) {
        window.location.assign("/sign-in?next=%2F");
        return;
      }
      const body = (await response.json().catch(() => undefined)) as { clientId?: string; message?: string } | undefined;
      if (!response.ok || !body?.clientId) {
        setProblem(body?.message ?? "Exterior could not register the app. Try again.");
        return;
      }
      setRegistered({
        clientName: clientName.trim(),
        configuration: JSON.stringify({ relayUrl: window.location.origin, clientId: body.clientId, redirectUri: redirectUri.trim() }, null, 2),
      });
    } catch {
      setProblem("Exterior could not be reached. Try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger render={<Button variant="outline" size="lg" className="shrink-0" />}>
        <PlusIcon data-icon="inline-start" aria-hidden />
        Register app
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        {registered ? (
          <>
            <DialogHeader className="gap-1 pr-8">
              <DialogTitle className="font-display text-xl font-bold">{registered.clientName} registered</DialogTitle>
              <DialogDescription>
                Pass this public configuration to the app's sign-in. The app requests device access when someone signs in.
              </DialogDescription>
            </DialogHeader>
            <pre className="overflow-auto rounded-md bg-muted p-4 font-mono text-sm">{registered.configuration}</pre>
            <DialogFooter>
              <DialogClose render={<Button variant="secondary" />}>Close</DialogClose>
              <CopyButton label="Copy configuration" text={registered.configuration} />
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader className="gap-1 pr-8">
              <DialogTitle className="font-display text-xl font-bold">Register an app</DialogTitle>
              <DialogDescription>
                Give an app in development a client id on this relay. A coding assistant can do this for you with <a href={appSetupGuide} target="_blank" rel="noreferrer">app setup</a>. A released app names itself by a <a href={clientIdGuide} target="_blank" rel="noreferrer">metadata document</a> on its site instead.
              </DialogDescription>
            </DialogHeader>
            <form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
              <FieldGroup className="gap-4">
                <Field>
                  <FieldLabel htmlFor="register-app-name">Name</FieldLabel>
                  <Input id="register-app-name" required maxLength={64} autoComplete="off" placeholder="My App" value={clientName} onChange={(event) => setClientName(event.target.value)} />
                  <FieldDescription>Shown when someone signs in to the app.</FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="register-app-callback">App URL</FieldLabel>
                  <Input id="register-app-callback" required type="url" className="font-mono" spellCheck={false} placeholder="http://localhost:5173/" value={redirectUri} onChange={(event) => setRedirectUri(event.target.value)} />
                  <FieldDescription>Use the app entry URL. Sign-in returns here.</FieldDescription>
                </Field>
              </FieldGroup>
              {problem ? (
                <Alert variant="destructive">
                  <CircleAlertIcon />
                  <AlertDescription>{problem}</AlertDescription>
                </Alert>
              ) : null}
              <DialogFooter>
                <DialogClose render={<Button variant="secondary" disabled={pending} />}>Cancel</DialogClose>
                <Button type="submit" loading={pending}>{pending ? "Registering" : "Register app"}</Button>
              </DialogFooter>
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
