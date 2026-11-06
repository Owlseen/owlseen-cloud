import type { SiteGroup } from "@/application/site-groups";
import type { SiteRow } from "@/application/sites";
import { ActionForm, ConfirmButton } from "@/components/try-button";
import { Card, FIELD } from "@/components/ui";
import { removeGroupAction, saveGroupAction } from "./actions";

function NewGroup({ sites }: { sites: readonly SiteRow[] }) {
  return (
    <details className="mt-4">
      <summary className="cursor-pointer text-sm text-muted-foreground">Make a group, or change one by giving its name</summary>
      <div className="mt-3">
        <ActionForm action={saveGroupAction} submit="Save this group" busy="Saving…">
          <input name="name" required maxLength={80} placeholder="A business, a language, a client" aria-label="Group’s name" className={FIELD} />
          <ul className="grid gap-1 text-sm sm:grid-cols-2 lg:grid-cols-3">
            {sites.map(({ id, name }) => (
              <li key={id}>
                <label className="flex items-center gap-2">
                  <input type="checkbox" name="site" value={id} />
                  {name}
                </label>
              </li>
            ))}
          </ul>
        </ActionForm>
      </div>
    </details>
  );
}

/** Sites read together, the way a company thinks of them. A group can be chosen wherever a site can. */
export function SiteGroups({ sites, groups, mayChange }: { sites: readonly SiteRow[]; groups: readonly SiteGroup[]; mayChange: boolean }) {
  return (
    <Card className="mt-6">
      <h2 className="font-semibold">Groups</h2>
      {groups.length === 0 && <p className="mt-1 text-sm text-muted-foreground">Sites read together, the way you think of them. A group can be chosen wherever a site can.</p>}
      {groups.length > 0 && (
        <ul className="mt-3 space-y-2 text-sm">
          {groups.map(({ id, name, siteIds }) => (
            <li key={id} data-group={name} className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="font-medium">{name}</span>
              <span className="font-mono text-xs text-muted-foreground">{siteIds.length === 1 ? "1 site" : `${siteIds.length} sites`}</span>
              {mayChange && <ConfirmButton action={removeGroupAction.bind(null, id)} label="Remove" confirm="Yes: remove this group, not its sites" />}
            </li>
          ))}
        </ul>
      )}
      {mayChange && <NewGroup sites={sites} />}
    </Card>
  );
}
