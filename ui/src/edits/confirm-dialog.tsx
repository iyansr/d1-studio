import type { Confirm, WritePreview } from "@shared/edits";
import { useRef, useState } from "react";
import { ErrorAlert } from "@/components/error-alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { ApiError, type Meta } from "@/lib/api";
import { StatementList } from "./statement-list";

/**
 * The confirmation of a remote write (T7): the exact SQL, and for destructive
 * SQL the database name typed. It is an AlertDialog, so an outside click
 * doesn't close it, and Esc and the focus trap come with it. Initial focus is
 * Cancel, or the name field, so Enter never runs anything by itself.
 */
export function WriteConfirmDialog(props: {
  /** Open while set. */
  preview: WritePreview | null;
  database: string;
  account: Meta["account"];
  /** Grid edits run in one transaction; the editor's statements don't. */
  atomic: boolean;
  running: boolean;
  /** The last run's failure, shown here so the SQL stays in view. */
  error: Error | null;
  onRun: (confirm: Confirm) => void;
  onCancel: () => void;
}) {
  const { preview, running } = props;
  return (
    <AlertDialog
      open={preview !== null}
      onOpenChange={(open) => {
        if (!open && !running) props.onCancel();
      }}
    >
      {preview && <ConfirmContent {...props} preview={preview} />}
    </AlertDialog>
  );
}

function ConfirmContent(
  props: Parameters<typeof WriteConfirmDialog>[0] & { preview: WritePreview },
) {
  const { preview, database, account, running, error } = props;
  const [typed, setTyped] = useState("");
  const cancel = useRef<HTMLButtonElement>(null);
  const name = useRef<HTMLInputElement>(null);
  const needsName = preview.requiresConfirm === "type-name";
  const matches = typed === database;
  const count = preview.statements.length;
  const noun = count === 1 ? "statement" : "statements";
  const confirm: Confirm = needsName ? typed : true;
  // A 429 was refused before it ran, so trying again can't apply twice. Other
  // failures of a write may have gone through, so they get no Retry.
  const retry = error instanceof ApiError && error.status === 429 && (!needsName || matches);

  return (
    <AlertDialogContent
      className="max-w-none sm:max-w-2xl data-[size=default]:sm:max-w-2xl"
      initialFocus={needsName ? name : cancel}
    >
      <AlertDialogHeader>
        <AlertDialogTitle>{`Run ${count} ${noun} on ${database}?`}</AlertDialogTitle>
        <AlertDialogDescription>
          {account ? `Account ${account.name ?? account.id}` : "Remote account"}
          {account?.name ? ` (${account.id.slice(0, 4)}…)` : ""}, database {database}.{" "}
          {props.atomic && count > 1 ? "All statements run in one transaction. " : ""}
          {preview.dangerous ? "Some of them are destructive." : "This changes live data."}
        </AlertDialogDescription>
      </AlertDialogHeader>

      <ScrollArea className="**:data-[slot=scroll-area-viewport]:max-h-[45vh]">
        <StatementList statements={preview.statements} />
      </ScrollArea>
      <p className="text-xs text-muted-foreground">
        Values are shown inline to read. They run as bound parameters.
      </p>

      {needsName && (
        <Field data-invalid={(typed !== "" && !matches) || undefined}>
          <FieldLabel htmlFor="confirm-name">Type {database} to confirm</FieldLabel>
          <Input
            id="confirm-name"
            ref={name}
            value={typed}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={(typed !== "" && !matches) || undefined}
            onChange={(event) => setTyped(event.target.value)}
          />
        </Field>
      )}

      {error && (
        <ErrorAlert
          title="Couldn't run the statements"
          error={error}
          onRetry={retry ? () => props.onRun(confirm) : undefined}
        />
      )}

      <AlertDialogFooter>
        <AlertDialogCancel ref={cancel} disabled={running}>
          Cancel
        </AlertDialogCancel>
        <AlertDialogAction
          variant={preview.dangerous ? "destructive" : "default"}
          disabled={running || (needsName && !matches)}
          onClick={() => props.onRun(confirm)}
        >
          {running && <Spinner data-icon="inline-start" />}
          {`Run ${count} ${noun}`}
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  );
}
