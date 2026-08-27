/**
 * Plugin-owned document metadata (roadmap "Plugins, hatches, and a loaded
 * truck", step 2): a namespaced, serialisable, undoable place for a plugin
 * to remember facts about an entity or group that the document itself
 * doesn't model — e.g. the truck-nesting plugin's "this group is pallet
 * type EUR1, 720 kg, unload stop 3".
 *
 * Stored on the document as `meta[pluginId][targetId] = value`, one level
 * per plugin so two plugins can never collide on the same key, and gone
 * entirely once every plugin using it is uninstalled and its entries
 * cleared. `targetId` is an `EntityId` or `GroupId` — the map doesn't care
 * which, since both are opaque strings.
 */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
