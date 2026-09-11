/**
 * occt-import-js ships no types. Only the surface the import worker uses is
 * declared; the result shape is `OcctResult` in ./types.ts.
 */
declare module "occt-import-js" {
  interface OcctFactoryOverrides {
    locateFile?: (path: string, scriptDirectory: string) => string;
  }
  const occtimportjs: (overrides?: OcctFactoryOverrides) => Promise<unknown>;
  export default occtimportjs;
}
