"use client"

import * as React from "react"
import { BracesIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import type { TemplateVariable } from "@/lib/domain/templates"
import { TEMPLATE_VARIABLE_HINTS } from "@/lib/schemas/message-templates"

/**
 * "Insert variable" (§7.13.4: variables are inserted from a picker). A searchable list grouped as
 * the spec groups them (Client · Work · Money · Links · Firm); choosing one inserts `{{name}}` at the
 * cursor of the field last focused. Employees don't get the Money group.
 */
export function VariablePicker({
  groups,
  onPick,
  disabled,
  label = "Insert variable",
}: {
  groups: Array<{ group: string; variables: readonly TemplateVariable[] }>
  onPick: (name: TemplateVariable) => void
  disabled?: boolean
  label?: string
}) {
  const [open, setOpen] = React.useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="ghost" size="xs" disabled={disabled} className="text-primary hover:text-primary">
          <BracesIcon aria-hidden="true" />
          {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(22rem,calc(100vw-2rem))] p-0">
        <Command>
          <CommandInput placeholder="Find a variable" />
          <CommandList className="max-h-[min(20rem,50dvh)]">
            <CommandEmpty>No variable by that name.</CommandEmpty>
            {groups.map((g) => (
              <CommandGroup key={g.group} heading={g.group}>
                {g.variables.map((v) => (
                  <CommandItem
                    key={v}
                    value={`${v} ${TEMPLATE_VARIABLE_HINTS[v]}`}
                    onSelect={() => {
                      onPick(v)
                      setOpen(false)
                    }}
                    className="flex flex-col items-start gap-0"
                  >
                    <span className="font-mono text-[13px] text-text">{`{{${v}}}`}</span>
                    <span className="text-xs text-text-muted">{TEMPLATE_VARIABLE_HINTS[v]}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
