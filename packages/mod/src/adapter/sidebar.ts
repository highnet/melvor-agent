/** Lets callers remove the sidebar entry again; the kill switch uses it. */
export interface PanelHandle {
  /** Updates the small right-aligned status text on the sidebar item. */
  setAside(text: string, className: string): void;
  /** Removes the sidebar item. */
  remove(): void;
}

export interface SidebarPanelOptions {
  categoryId: string;
  itemId: string;
  name: string;
  /** Mod context, used to resolve the icon to a servable URL. */
  ctx: Modding.ModContext;
  /** Icon path relative to the mod root, e.g. `assets/icon.svg`. */
  iconPath: string;
  /** Called when the operator clicks the sidebar entry. */
  onClick: () => void;
}

/**
 * Registers the agent's sidebar entry.
 *
 * `sidebar` is a global, not part of the mod context. Categories and items are
 * get-or-create, so this is safe to call more than once — a reload that
 * re-registers will configure the existing entry rather than duplicating it.
 *
 * @param options - Identity and click behaviour for the entry.
 * @returns A handle for updating the status text and removing the entry.
 */
export function addSidebarPanel(options: SidebarPanelOptions): PanelHandle {
  // An icon-font class would depend on the game shipping that exact glyph, which
  // is not part of the documented mod API — the first attempt used one and
  // rendered nothing at all. A mod-owned image resolved through
  // `getResourceUrl` has no such dependency.
  const icon = document.createElement('img');
  icon.src = options.ctx.getResourceUrl(options.iconPath);
  icon.alt = '';
  icon.style.width = '1.5rem';
  icon.style.height = '1.5rem';

  const category = sidebar.category(options.categoryId);
  const item = category.item(options.itemId, {
    name: options.name,
    icon,
    aside: 'idle',
    asideClass: 'text-muted',
    onClick: options.onClick,
  });

  return {
    setAside(text: string, className: string): void {
      category.item(options.itemId, { aside: text, asideClass: className });
    },
    remove(): void {
      item.remove();
    },
  };
}
