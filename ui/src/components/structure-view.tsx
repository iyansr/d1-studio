import { useQuery } from '@tanstack/react-query';
import { CopyIcon, KeyRoundIcon, LinkIcon, ListTreeIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { toast } from 'sonner';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { CodeView } from '@/editor/code-view';
import { queries, type TableSchema } from '@/lib/api';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The Structure tab (UI-9): columns, indexes, foreign keys and the DDL. */
export function StructureView({
  table,
  onOpenTable,
}: {
  table: string;
  onOpenTable: (name: string) => void;
}) {
  const schema = useQuery(queries.schema(table));

  if (schema.isPending) {
    return (
      <div className="flex flex-col gap-4 p-4">
        {['a', 'b', 'c'].map((k) => (
          <Skeleton key={k} className="h-40 w-full" />
        ))}
      </div>
    );
  }
  if (schema.isError) {
    return (
      <div className="p-4">
        <Alert variant="destructive">
          <AlertTitle>Couldn't read the schema</AlertTitle>
          <AlertDescription className="font-mono">{schema.error.message}</AlertDescription>
        </Alert>
      </div>
    );
  }

  const s = schema.data;
  const kind = s.type === 'view' ? 'view' : 'table';
  const traits = [
    s.withoutRowid && 'WITHOUT ROWID',
    s.strict && 'STRICT',
    s.type === 'virtual' && 'virtual',
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="flex flex-col gap-4 p-4">
      <Section
        title="Columns"
        description={[plural(s.columns.length, 'column'), traits].filter(Boolean).join(' · ')}
      >
        <Columns schema={s} />
      </Section>

      {kind === 'table' && (
        <Section title="Indexes" description={plural(s.indexes.length, 'index', 'indexes')}>
          {s.indexes.length === 0 ? (
            <None
              title="No indexes"
              description="Lookups other than by the primary key scan the table."
            />
          ) : (
            <Indexes schema={s} />
          )}
        </Section>
      )}

      {kind === 'table' && (
        <Section title="Foreign keys" description={plural(s.foreignKeys.length, 'foreign key')}>
          {s.foreignKeys.length === 0 ? (
            <None
              title="No foreign keys"
              description={`${table} doesn't reference other tables.`}
            />
          ) : (
            <ForeignKeys schema={s} onOpenTable={onOpenTable} />
          )}
        </Section>
      )}

      <Card>
        <CardHeader>
          <CardTitle>CREATE statement</CardTitle>
          <CardDescription>As stored in sqlite_schema</CardDescription>
          {s.sql && (
            <CardAction>
              <Button variant="outline" size="sm" onClick={() => copyDdl(s.sql as string)}>
                <CopyIcon data-icon="inline-start" />
                Copy
              </Button>
            </CardAction>
          )}
        </CardHeader>
        <CardContent>
          {s.sql ? (
            <CodeView value={s.sql} language="sql" label={`CREATE statement for ${table}`} />
          ) : (
            <None title="No statement" description="SQLite keeps no DDL for this object." />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

async function copyDdl(sql: string) {
  try {
    await navigator.clipboard.writeText(sql);
    toast.success('CREATE statement copied');
  } catch {
    toast.error("Couldn't copy to the clipboard");
  }
}

function Section(props: { title: string; description: string; children: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{props.title}</CardTitle>
        <CardDescription>{props.description}</CardDescription>
      </CardHeader>
      <CardContent>{props.children}</CardContent>
    </Card>
  );
}

function None(props: { title: string; description: string }) {
  return (
    <Empty className="p-4">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <ListTreeIcon />
        </EmptyMedia>
        <EmptyTitle>{props.title}</EmptyTitle>
        <EmptyDescription>{props.description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

const muted = <span className="text-muted-foreground">—</span>;

function Columns({ schema }: { schema: TableSchema }) {
  const compositePk = schema.primaryKey.length > 1;
  const fkOf = new Map(
    schema.foreignKeys.flatMap((fk) =>
      fk.from.map((from, i) => [from, `${fk.table}(${fk.to[i] ?? '…'})`] as const),
    ),
  );
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Type</TableHead>
          <TableHead>Default</TableHead>
          <TableHead>Flags</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {schema.columns.map((c) => (
          <TableRow key={c.name}>
            <TableCell className="font-mono">
              <span className="flex items-center gap-1.5">
                {c.pk > 0 && (
                  <KeyRoundIcon aria-hidden className="size-3.5 text-muted-foreground" />
                )}
                {fkOf.has(c.name) && (
                  <LinkIcon aria-hidden className="size-3.5 text-muted-foreground" />
                )}
                {c.name}
              </span>
            </TableCell>
            <TableCell className="font-mono">{c.type || muted}</TableCell>
            <TableCell className="font-mono">{c.defaultValue ?? muted}</TableCell>
            <TableCell>
              <span className="flex flex-wrap gap-1">
                {c.pk > 0 && <Badge>{compositePk ? `PK ${c.pk}` : 'PK'}</Badge>}
                {c.notNull && <Badge variant="secondary">NOT NULL</Badge>}
                {c.generated && (
                  <Badge variant="outline">GENERATED {c.generated.toUpperCase()}</Badge>
                )}
                {c.hidden && <Badge variant="outline">HIDDEN</Badge>}
                {fkOf.has(c.name) && <Badge variant="outline">FK → {fkOf.get(c.name)}</Badge>}
              </span>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function Indexes({ schema }: { schema: TableSchema }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Columns</TableHead>
          <TableHead>Where</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {schema.indexes.map((index) => (
          <TableRow key={index.name}>
            <TableCell className="font-mono">
              <span className="flex flex-wrap items-center gap-1.5">
                {index.name}
                {index.unique && <Badge variant="secondary">UNIQUE</Badge>}
                {index.origin === 'pk' && <Badge variant="outline">PRIMARY KEY</Badge>}
              </span>
            </TableCell>
            <TableCell className="font-mono">
              {index.columns
                .map((col, i) => `${col ?? '(expression)'}${index.desc[i] ? ' DESC' : ''}`)
                .join(', ')}
            </TableCell>
            <TableCell className="font-mono whitespace-normal">{index.where ?? muted}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function ForeignKeys({
  schema,
  onOpenTable,
}: {
  schema: TableSchema;
  onOpenTable: (name: string) => void;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Reference</TableHead>
          <TableHead>On update</TableHead>
          <TableHead>On delete</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {schema.foreignKeys.map((fk) => (
          <TableRow key={fk.id}>
            <TableCell className="font-mono">
              <span className="flex items-center gap-1">
                {fk.from.join(', ')} →
                <Button
                  variant="link"
                  size="sm"
                  className="h-auto px-0 font-mono"
                  onClick={() => onOpenTable(fk.table)}
                >
                  {fk.table}
                </Button>
                ({fk.to.map((t) => t ?? 'primary key').join(', ')})
              </span>
            </TableCell>
            <TableCell className="font-mono">{fk.onUpdate}</TableCell>
            <TableCell className="font-mono">{fk.onDelete}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
