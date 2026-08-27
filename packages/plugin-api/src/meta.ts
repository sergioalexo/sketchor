/** Mirrors `@sketchor/core`'s `Json` — the only value shape that can survive `structuredClone`, which is what crossing the plugin boundary requires once plugins run in a Worker. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
