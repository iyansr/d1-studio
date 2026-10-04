import { FilterIcon, PlusIcon, XIcon } from 'lucide-react';
import { useEffect, useId, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldGroup } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  type Draft,
  draftOf,
  newKey,
  numeric,
  OP_ITEMS,
  OP_LABELS,
  parseValue,
} from '@/lib/filters';
import { type Filter, type RowsColumn, UNARY_OPS } from '@shared/rows';

/** Per-column filter builder (UI-4). Rows combine with AND. */
export function FilterBuilder(props: {
  columns: RowsColumn[];
  filters: Filter[];
  onApply: (filters: Filter[]) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Add a row for this column when opening (header menu "Filter…"). */
  seed: string | null;
}) {
  const { columns, filters } = props;
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [showErrors, setShowErrors] = useState(false);
  const typeOf = (col: string) => columns.find((c) => c.name === col)?.type ?? '';
  const columnItems = columns.map((c) => ({ value: c.name, label: c.name }));
  const blank = (col = columns[0]?.name ?? ''): Draft => ({
    key: newKey(),
    col,
    op: 'eq',
    value: '',
  });

  // Start from the applied filters each time it opens, from the trigger or
  // from a header menu (which seeds a row for its column).
  /* oxlint-disable react-hooks/exhaustive-deps -- only when opening. */
  useEffect(() => {
    if (!props.open) return;
    const current = filters.map(draftOf);
    setDrafts(props.seed ? [...current, blank(props.seed)] : current.length ? current : [blank()]);
    setShowErrors(false);
  }, [props.open, props.seed]);
  /* oxlint-enable react-hooks/exhaustive-deps */

  const update = (key: number, patch: Partial<Draft>) =>
    setDrafts((ds) => ds.map((d) => (d.key === key ? { ...d, ...patch } : d)));
  const parsed = drafts.map((d) => ({ draft: d, ...parseValue(d, typeOf(d.col)) }));

  const apply = () => {
    if (parsed.some((p) => p.error)) {
      setShowErrors(true);
      return;
    }
    props.onApply(
      parsed.map(({ draft, value }) =>
        UNARY_OPS.has(draft.op)
          ? { col: draft.col, op: draft.op }
          : { col: draft.col, op: draft.op, value },
      ),
    );
    props.onOpenChange(false);
    setDrafts([]);
  };

  return (
    <Popover open={props.open} onOpenChange={props.onOpenChange}>
      <PopoverTrigger render={<Button variant="outline" size="sm" />}>
        <FilterIcon data-icon="inline-start" />
        Filter
        {filters.length > 0 && <Badge variant="secondary">{filters.length}</Badge>}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(40rem,calc(100vw-2rem))] gap-3 p-3">
        <PopoverHeader>
          <PopoverTitle>Filters</PopoverTitle>
          <PopoverDescription>Rows must match every filter.</PopoverDescription>
        </PopoverHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            apply();
          }}
        >
          <FieldGroup className="gap-2">
            {parsed.map(({ draft, error }) => (
              <FilterRow
                key={draft.key}
                draft={draft}
                type={typeOf(draft.col)}
                columnItems={columnItems}
                error={showErrors ? error : undefined}
                onChange={(patch) => update(draft.key, patch)}
                onRemove={() => setDrafts((ds) => ds.filter((d) => d.key !== draft.key))}
              />
            ))}
          </FieldGroup>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setDrafts((ds) => [...ds, blank()])}
            >
              <PlusIcon data-icon="inline-start" />
              Add filter
            </Button>
            <div className="ml-auto flex gap-2">
              {filters.length > 0 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    props.onApply([]);
                    props.onOpenChange(false);
                    setDrafts([]);
                  }}
                >
                  Clear all
                </Button>
              )}
              <Button type="submit" size="sm">
                Apply
              </Button>
            </div>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}

function FilterRow(props: {
  draft: Draft;
  type: string;
  columnItems: { value: string; label: string }[];
  error?: string;
  onChange: (patch: Partial<Draft>) => void;
  onRemove: () => void;
}) {
  const { draft, type } = props;
  const id = useId();
  const unary = UNARY_OPS.has(draft.op);
  const like = draft.op === 'like' || draft.op === 'nlike';
  const isNumeric = numeric(type) && !like;
  return (
    <Field data-invalid={props.error ? true : undefined} className="gap-1">
      <div className="flex items-center gap-2">
        <Select
          items={props.columnItems}
          value={draft.col}
          onValueChange={(col) => col && props.onChange({ col })}
        >
          <SelectTrigger size="sm" className="w-44 min-w-0" aria-label="Column">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {props.columnItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <Select
          items={OP_ITEMS}
          value={draft.op}
          onValueChange={(op) => op && props.onChange({ op })}
        >
          <SelectTrigger size="sm" className="w-32" aria-label="Operator">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {OP_ITEMS.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        {!unary && (
          <Input
            aria-label="Value"
            aria-invalid={props.error ? true : undefined}
            aria-describedby={props.error || like ? `${id}-hint` : undefined}
            type={isNumeric ? 'number' : 'text'}
            step={isNumeric ? 'any' : undefined}
            inputMode={isNumeric ? 'decimal' : undefined}
            className="h-7 min-w-0 flex-1"
            value={draft.value}
            placeholder={like ? '%text%' : isNumeric ? '0' : 'value'}
            onChange={(e) => props.onChange({ value: e.target.value })}
          />
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="ml-auto"
          aria-label="Remove filter"
          onClick={props.onRemove}
        >
          <XIcon />
        </Button>
      </div>
      {(props.error || like) && (
        <FieldDescription
          id={`${id}-hint`}
          className={props.error ? 'text-destructive' : undefined}
        >
          {props.error ?? '% matches any run of characters, _ matches one.'}
        </FieldDescription>
      )}
    </Field>
  );
}

/** Active filters as removable badges under the toolbar. */
export function FilterBadges(props: { filters: Filter[]; onRemove: (index: number) => void }) {
  if (props.filters.length === 0) return null;
  return (
    <ul aria-label="Active filters" className="flex flex-wrap items-center gap-1.5">
      {props.filters.map((f, i) => {
        const value =
          f.value === undefined
            ? ''
            : typeof f.value === 'object' && f.value !== null
              ? f.value.$int
              : JSON.stringify(f.value);
        const text = `${f.col} ${OP_LABELS[f.op]} ${value}`.trim();
        return (
          // Filters can repeat; position is the identity.
          <li key={i}>
            <Badge variant="secondary" className="h-6 gap-1 pr-0.5 font-mono">
              {text}
              <Button
                variant="ghost"
                size="icon-xs"
                className="size-5 rounded-full"
                aria-label={`Remove filter ${text}`}
                onClick={() => props.onRemove(i)}
              >
                <XIcon />
              </Button>
            </Badge>
          </li>
        );
      })}
    </ul>
  );
}
