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
  const category = sidebar.category(options.categoryId);
  const item = category.item(options.itemId, {
    name: options.name,
    // Reuse the game's own icon and text classes rather than shipping a design
    // system; these are the classes the game's own sidebar items already use.
    icon: '<span class="fa fa-robot"></span>',
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
