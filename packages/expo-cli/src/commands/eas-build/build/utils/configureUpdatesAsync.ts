import { Platform } from '@expo/build-tools';
import { getConfig, getExpoSDKVersion, getPackageJson } from '@expo/config';
import { UserManager } from '@expo/xdl';
import chalk from 'chalk';
import dedent from 'dedent';
import figures from 'figures';
import * as fs from 'fs-extra';
import glob from 'glob';
import { reject } from 'lodash';
import ora from 'ora';
import path from 'path';
import xcode from 'xcode';
import { DOMParser, XMLSerializer } from 'xmldom';

import { gitAddAsync } from '../../../../git';
import log from '../../../../log';
import * as gitUtils from '../../utils/git';

interface UpdateOptions {
  sdkVersion: string;
  runtimeVersion?: string;
  updateUrl: string;
}

const platformDisplayNames = {
  [Platform.Android]: 'Android',
  [Platform.iOS]: 'iOS',
};

export default async function configureUpdatesAsync({
  projectDir,
  nonInteractive,
  platform,
}: {
  projectDir: string;
  nonInteractive: boolean;
  platform: Platform;
}) {
  const user = await UserManager.ensureLoggedInAsync();

  const packageJson = getPackageJson(projectDir);

  if (!(packageJson.dependencies && packageJson.dependencies['expo-updates'])) {
    return;
  }

  const spinner = ora(`Configuring expo-updates for ${platformDisplayNames[platform]}`);

  const { exp } = getConfig(projectDir);
  const sdkVersion = getExpoSDKVersion(projectDir, exp);

  const options = {
    sdkVersion,
    runtimeVersion: exp.runtimeVersion,
    updateUrl: `https://exp.host/@${user.username}/${exp.slug}`,
  };

  switch (platform) {
    case Platform.Android:
      await configureUpdatesAndroid(projectDir, options);
      break;
    case Platform.iOS:
      await configureUpdatesIOS(projectDir, options);
      break;
  }

  try {
    await gitUtils.ensureGitStatusIsCleanAsync();
    spinner.succeed();
  } catch (err) {
    if (err instanceof gitUtils.DirtyGitTreeError) {
      spinner.succeed(
        `We configured expo-updates in your project for ${platformDisplayNames[platform]}`
      );
      log.newLine();

      try {
        await gitUtils.reviewAndCommitChangesAsync(
          `Configure expo-updates for ${platformDisplayNames[platform]}`,
          { nonInteractive }
        );

        log(`${chalk.green(figures.tick)} Successfully committed the configuration changes.`);
      } catch (e) {
        throw new Error(
          "Aborting, run the command again once you're ready. Make sure to commit any changes you've made."
        );
      }
    } else {
      spinner.fail();
      throw err;
    }
  }
}

async function configureUpdatesIOS(
  projectDir: string,
  { sdkVersion, runtimeVersion, updateUrl }: UpdateOptions
) {
  const pbxprojPaths = await new Promise<string[]>((resolve, reject) =>
    glob('ios/*/project.pbxproj', { absolute: true, cwd: projectDir }, (err, res) => {
      if (err) {
        reject(err);
      } else {
        resolve(res);
      }
    })
  );
  const pbxprojPath = pbxprojPaths.length > 0 ? pbxprojPaths[0] : undefined;

  if (!pbxprojPath) {
    throw new Error("Couldn't find XCode project");
  }

  const project = xcode.project(pbxprojPath);

  await new Promise((resolve, reject) =>
    project.parse(err => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    })
  );

  const scriptBuildPhase = project.hash.project.objects.PBXShellScriptBuildPhase;
  const bundleReactNative = Object.values(scriptBuildPhase).find(
    buildPhase => buildPhase.name === '"Bundle React Native code and images"'
  );

  if (!bundleReactNative) {
    reject(
      new Error(`Couldn't find a build phase script for "Bundle React Native code and images"`)
    );
    return;
  }

  const { shellScript } = bundleReactNative;
  const expoUpdatesScript = '../node_modules/expo-updates/scripts/create-manifest-ios.sh';

  if (!shellScript.includes(expoUpdatesScript)) {
    bundleReactNative.shellScript = `${shellScript.replace(/"$/, '')}${expoUpdatesScript}\\n"`;
  }

  await fs.writeFile(pbxprojPath, project.writeSync());

  const xcodeprojPath = path.resolve(pbxprojPath, '..');
  const expoPlistPath = path.resolve(
    projectDir,
    'ios',
    path.basename(xcodeprojPath).replace(/\.xcodeproj$/, ''),
    'Supporting',
    'Expo.plist'
  );

  const items = runtimeVersion
    ? {
        EXUpdatesRuntimeVersion: runtimeVersion,
        EXUpdatesURL: updateUrl,
      }
    : {
        EXUpdatesSDKVersion: sdkVersion,
        EXUpdatesURL: updateUrl,
      };

  const expoPlist = dedent`
  <?xml version="1.0" encoding="UTF-8"?>
  <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
  <plist version="1.0">
    <dict>${Object.entries(items)
      .map(([key, value]) => `\n      <key>${key}</key>\n      <string>${value}</string>`)
      .join('')}
    </dict>
  </plist>
  `;

  if (!(await fs.pathExists(path.dirname(expoPlistPath)))) {
    await fs.mkdirp(path.dirname(expoPlistPath));
  }

  await fs.writeFile(expoPlistPath, expoPlist);
  await gitAddAsync(expoPlistPath, { intentToAdd: true });
}

async function configureUpdatesAndroid(
  projectDir: string,
  { sdkVersion, runtimeVersion, updateUrl }: UpdateOptions
) {
  const buildGradlePath = path.join(projectDir, 'android', 'app', 'build.gradle');

  if (!(await fs.pathExists(buildGradlePath))) {
    throw new Error(`Couldn't find gradle build script at ${buildGradlePath}`);
  }

  const buildGradleContent = await fs.readFile(buildGradlePath, 'utf-8');
  const applyBuildScript =
    'apply from: "../../node_modules/expo-updates/scripts/create-manifest-android.gradle"';

  const hasBuildScriptApply = buildGradleContent
    .split('\n')
    // Check for both single and double quotes
    .some(line => line === applyBuildScript || line === applyBuildScript.replace(/"/g, "'"));

  if (!hasBuildScriptApply) {
    await fs.writeFile(
      buildGradlePath,
      `${buildGradleContent}\n// Integration with Expo updates\n${applyBuildScript}\n`
    );
  }

  const manifestPath = path.join(
    projectDir,
    'android',
    'app',
    'src',
    'main',
    'AndroidManifest.xml'
  );

  if (!(await fs.pathExists(manifestPath))) {
    throw new Error(`Couldn't find Android manifest at ${manifestPath}`);
  }

  const manifestText = await fs.readFile(manifestPath, 'utf8');
  const manifestXml = new DOMParser().parseFromString(manifestText);

  if (runtimeVersion) {
    removeMetadata(manifestXml, 'expo.modules.updates.EXPO_SDK_VERSION');
    updateMetadata(manifestXml, 'expo.modules.updates.EXPO_RUNTIME_VERSION', runtimeVersion);
  } else {
    removeMetadata(manifestXml, 'expo.modules.updates.EXPO_RUNTIME_VERSION');
    updateMetadata(manifestXml, 'expo.modules.updates.EXPO_SDK_VERSION', sdkVersion);
  }

  updateMetadata(manifestXml, 'expo.modules.updates.EXPO_UPDATE_URL', updateUrl);

  await fs.writeFile(manifestPath, new XMLSerializer().serializeToString(manifestXml));
}

function findMetadata(application: Element, name: string) {
  const metadata = (Array.from(application.childNodes) as Element[]).find(
    node =>
      node.nodeName === 'meta-data' &&
      Array.from(node.attributes).some(attr => attr.name === 'android:name' && attr.value === name)
  );

  return metadata;
}

function updateMetadata(document: Document, name: string, value: string) {
  const application = document.getElementsByTagName('application')[0];
  const metadata = findMetadata(application, name);

  if (metadata) {
    metadata.setAttribute('android:value', value);
  } else {
    const it = document.createElement('meta-data');

    it.setAttribute('android:name', name);
    it.setAttribute('android:value', value);

    application.appendChild(document.createTextNode('  '));
    application.appendChild(it);
    application.appendChild(document.createTextNode('\n    '));
  }
}

function removeMetadata(document: Document, name: string) {
  const application = document.getElementsByTagName('application')[0];
  const metadata = findMetadata(application, name);

  if (metadata) {
    application.removeChild(metadata);
  }
}
