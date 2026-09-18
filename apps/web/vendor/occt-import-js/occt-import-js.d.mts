/**
 * Type surface of the vendored occt-import-js glue (see README.md in
 * native/occt-import-js-build). Only what the import worker uses is
 * declared; the result shape is `OcctResult` in src/model3d/types.ts.
 */
export interface OcctFactoryOverrides {
  locateFile?: (path: string, scriptDirectory: string) => string;
}
declare const occtimportjs: (overrides?: OcctFactoryOverrides) => Promise<unknown>;
export default occtimportjs;
