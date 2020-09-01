declare module 'xcode' {
  type XCObjectType =
    | 'PBXBuildFile'
    | 'PBXFileReference'
    | 'PBXFrameworksBuildPhase'
    | 'PBXGroup'
    | 'PBXNativeTarget'
    | 'PBXProject'
    | 'PBXResourcesBuildPhase'
    | 'PBXShellScriptBuildPhase'
    | 'PBXSourcesBuildPhase'
    | 'PBXVariantGroup'
    | 'XCBuildConfiguration'
    | 'XCConfigurationList';

  type XCodeProject = {
    parse(callback: (err: Error | null) => void): void;
    parseSync(): void;
    writeSync(): string;
    pbxXCBuildConfigurationSection(): any[];
    addToPbxFileReferenceSection(file: any): void;
    addToPbxBuildFileSection(file: any): void;
    addToPbxSourcesBuildPhase(file: any): void;
    generateUuid(): string;
    filepath: string;
    hash: {
      project: {
        archiveVersion: number;
        objectVersion: number;
        objects: {
          [T in XCObjectType]: Record<
            string,
            {
              isa: T;
              name: string;
              [key: string]: any;
            }
          >;
        };
        rootObject: string;
        rootObject_comment: string;
      };
      headComment: string;
    };
  };

  export function project(projectPath: string): XCodeProject;
}
