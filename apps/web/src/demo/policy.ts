/** Whether the showcase drawing should load: `?demo` forces, `?blank` skips, otherwise only the web build's first-ever open. */
export function shouldLoadDemo(search: string, seen: boolean, tauri: boolean, empty: boolean): boolean {
  const q = new URLSearchParams(search);
  if (q.has("blank")) return false;
  if (q.has("demo")) return true;
  return !tauri && !seen && empty;
}
