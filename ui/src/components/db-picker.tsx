import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DatabaseIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { api, type Candidate, type Meta, queries } from "@/lib/api";
import { formatBytes, formatCount, formatRelative } from "@/lib/format";

/**
 * needs-db: no local file matched the binding, so the user picks one
 * (PRD "tell DB from ANALYTICS at a glance").
 */
export function DbPicker({ meta }: { meta: Meta }) {
  const candidates = useQuery(queries.candidates());
  const client = useQueryClient();
  const open = useMutation({
    mutationFn: (id: number) => api.open(id),
    // The meta query flips to "ready", and App renders the studio.
    onSuccess: () => client.invalidateQueries(),
  });
  const binding = meta.unmatched?.binding ?? meta.unmatched?.name ?? "DB";

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-6 p-6">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <DatabaseIcon aria-hidden className="size-4" />
        d1-studio
      </div>
      <Alert>
        <AlertTitle>
          Couldn't match binding <code className="font-mono">{binding}</code> to a local file.
        </AlertTitle>
        <AlertDescription>Pick the database:</AlertDescription>
      </Alert>
      {open.isError && (
        <Alert variant="destructive">
          <AlertTitle>Couldn't open that file</AlertTitle>
          <AlertDescription className="font-mono">{open.error.message}</AlertDescription>
        </Alert>
      )}
      {candidates.isPending ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Skeleton className="h-36" />
          <Skeleton className="h-36" />
        </div>
      ) : candidates.isError ? (
        <Alert variant="destructive">
          <AlertTitle>Couldn't list the local files</AlertTitle>
          <AlertDescription>{candidates.error.message}</AlertDescription>
        </Alert>
      ) : (
        <ul aria-label="Local database files" className="grid gap-4 sm:grid-cols-2">
          {candidates.data.candidates.map((c) => (
            <li key={c.id}>
              <CandidateCard
                candidate={c}
                opening={open.isPending && open.variables === c.id}
                disabled={open.isPending}
                onPick={() => open.mutate(c.id)}
              />
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

function CandidateCard(props: {
  candidate: Candidate;
  opening: boolean;
  disabled: boolean;
  onPick: () => void;
}) {
  const c = props.candidate;
  const shortId = c.fileName.replace(/\.sqlite$/, "").slice(0, 12);
  const unreadable = c.error !== undefined;
  return (
    // The title's button covers the card, so the whole card is one control.
    <Card className="relative h-full transition-colors hover:bg-muted/40 has-[button:focus-visible]:ring-3 has-[button:focus-visible]:ring-ring/50">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 font-mono">
          <button
            type="button"
            disabled={props.disabled || unreadable}
            onClick={props.onPick}
            className="text-left outline-none after:absolute after:inset-0 after:rounded-xl disabled:cursor-not-allowed"
            aria-label={`Open ${shortId}…, ${c.tables.map((t) => t.name).join(", ") || "no tables"}`}
          >
            {shortId}…
          </button>
          {props.opening && <Spinner />}
        </CardTitle>
        <CardDescription>
          Modified {formatRelative(new Date(c.mtime))} · {formatBytes(c.size)}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {unreadable ? (
          <p className="text-sm text-destructive">{c.error}</p>
        ) : c.tables.length === 0 ? (
          <p className="text-sm text-muted-foreground">No tables</p>
        ) : (
          <ul aria-label="Tables" className="flex flex-wrap gap-1.5">
            {c.tables.map((t) => (
              <li key={t.name}>
                <Badge variant="secondary" className="font-mono">
                  {t.name}
                  {t.rows !== null && (
                    <span className="text-muted-foreground">{formatCount(t.rows)}</span>
                  )}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
