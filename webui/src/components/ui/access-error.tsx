import { CircleAlertIcon } from "lucide-react";
import { useId } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button, Spinner } from "@/components/ui/index";
import type { BackendError } from "@/lib/backend";

export function AccessError({
  error,
  reconnect,
  waiting = false,
}: {
  error: BackendError;
  reconnect?: () => void;
  waiting?: boolean;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const authentication =
    error.code === "authentication_missing" ||
    error.code === "authentication_failed";
  const startup = error.code === "startup_failed";
  const preparation = [
    "storage_read_failed",
    "storage_write_failed",
    "url_cleanup_failed",
    "invalid_connection",
  ].includes(error.code);
  const title = authentication
    ? "Access to Huddol requires authentication"
    : startup
      ? "Unable to start Huddol"
      : error.code === "protocol_error"
        ? "Huddol sent an invalid response"
        : preparation
          ? "Unable to prepare the connection"
          : "Could not connect to Huddol";

  return (
    <main className="flex h-dvh w-full overflow-auto bg-surface p-6">
      <div className="m-auto w-full max-w-[520px] min-w-0">
        <Alert
          aria-labelledby={titleId}
          aria-describedby={descriptionId}
          className="[overflow-wrap:anywhere]"
        >
          <CircleAlertIcon aria-hidden="true" />
          <AlertTitle id={titleId}>{title}</AlertTitle>
          <AlertDescription id={descriptionId}>
            <p className="whitespace-pre-wrap">{error.message}</p>
            {authentication ? (
              <p>
                Open Huddol from the application, or use the access link
                provided when Huddol starts. That link includes the credentials
                needed to connect.
              </p>
            ) : startup ? (
              <p>Close this window and start Huddol again.</p>
            ) : reconnect ? (
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <Button onClick={reconnect} disabled={waiting}>
                  {waiting ? <Spinner label="Reconnecting" /> : null}
                  {waiting ? "Reconnecting…" : "Reconnect"}
                </Button>
              </div>
            ) : null}
          </AlertDescription>
        </Alert>
      </div>
    </main>
  );
}
