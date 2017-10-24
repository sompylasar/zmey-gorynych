#!/usr/bin/env node
"use strict";

var fs = require('fs-extra');
var path = require('path');
var spawn = require('child_process').spawn;
var chalk = require('chalk');
var rimraf = require('rimraf');
var dircompare = require('dir-compare');
var Listr = require('listr');
var ListrMultilineRenderer = require('listr-multiline-renderer');
var ListrVerboseRenderer = require('listr-verbose-renderer');
var semver = require('semver');
var downloadNpmPackage = require('download-npm-package');
var JsDiff = require('diff');
var program = require('commander');
var minimatch = require('minimatch');
var CtrlC = require('ctrl-c');
var debug = require('debug')('zmey-gorynych');


program
  .option('--glob <wildcard>', 'Only process the packages in directories that match (via `minimatch`).')
  .option('--git-changed-only', 'Only process the packages that have files changed in `git`.')
  .option('--diff', 'Print package content diffs.')
  .option('--updates', 'Print package dependency updates.')
  .option('--bump', 'Bump the versions in package.json files to the suggested versions.')
  .option('--upgrade', 'Upgrade versions of known packages in all packages.')
  .option('--publish', 'Bump the versions in package.json files to the suggested versions and publish to npm.')
  .option('--intro', 'Show the intro picture.')
  .option('--keep-temp', 'Keep the temporary directory for investigation.')
  .parse(process.argv);


function preparePathForDisplay(filepath) {
  return ('./' + path.relative(process.cwd(), filepath));
}

function lstatPromised(filepath) {
  return new Promise(function (resolve, reject) {
    fs.lstat(filepath, function (error, lstat) {
      if (error) { reject(error); }
      else { resolve(lstat); }
    });
  });
}

function readFilePromised(filepath) {
  return new Promise(function (resolve, reject) {
    fs.readFile(filepath, function (error, buffer) {
      if (error) { reject(error); }
      else { resolve(buffer); }
    });
  });
}

function writeFilePromised(filepath, content) {
  return new Promise(function (resolve, reject) {
    fs.writeFile(filepath, content, function (error, buffer) {
      if (error) { reject(error); }
      else { resolve(buffer); }
    });
  });
}

function removeDirectoryPromised(dirpath) {
  return new Promise(function (resolve, reject) {
    rimraf(dirpath, { disableGlob: true }, function (error) {
      if (error) { reject(error); }
      else { resolve(); }
    });
  });
}

function getChildInfosPromised(dirpath) {
  return new Promise(function (resolve, reject) {
    fs.readdir(dirpath, function (error, childnames) {
      if (error) { reject(error); }
      else {
        var childpaths = childnames.map(function (childname) { return path.join(dirpath, childname); });
        var lstatsPromises = childpaths.map(function (childpath) { return lstatPromised(childpath); });
        Promise.all(lstatsPromises)
          .then(function (lstats) {
            resolve(childpaths.map(function (childpath, index) {
              return {
                dirpath: dirpath,
                childpath: childpath,
                childname: childnames[index],
                lstat: lstats[index],
              };
            }));
          })
          .catch(reject);
      }
    });
  });
}

function getFlatTreePromised(dirpath) {
  return new Promise(function (resolve, reject) {
    var scan = [ dirpath ];
    var tree = [];
    function next() {
      var d = scan.shift();
      if (!d) { resolve(tree); }
      else {
        getChildInfosPromised(d)
          .then(function (childInfos) {
            childInfos.forEach(function (childInfo) {
              tree.push(childInfo);
              if (childInfo.lstat.isDirectory()) {
                if (childInfo.childname !== 'node_modules') {
                  scan.push(childInfo.childpath);
                }
              }
            });
            next();
          })
          .catch(reject);
      }
    }
    next();
  });
}

function getPackageInfosPromised(dirpaths) {
  return new Promise(function (resolve) {
    var packageJsonPaths = dirpaths.map(function (dirpath) { return path.join(dirpath, 'package.json'); });
    resolve(Promise.all(packageJsonPaths.map(function (packageJsonPath) {
      return readFilePromised(packageJsonPath).then(
        function (buffer) { return JSON.parse(buffer.toString()); }
      ).catch(
        function (error) { if (error.code === 'ENOENT') { return null; } else { throw error; } }
      );
    })).then(function (packageJsons) {
      return packageJsons.map(function (packageJson, index) {
        return {
          dirpath: dirpaths[index],
          packageJsonPath: packageJsonPaths[index],
          packageJson: packageJson,
        };
      }).filter(function (packageInfo) {
        var packageJson = packageInfo.packageJson;
        return !!(
          packageJson &&
          typeof packageJson.name === 'string' && packageJson.name &&
          !packageJson.private &&
          Array.isArray(packageJson.files) && packageJson.files.length > 0
        );
      });
    }));
  });
}

var _processesToInterrupt = [];
function makeChildProcessInterruptible(childProcess) {
  childProcess.on('close', function () {
    var index = _processesToInterrupt.indexOf(childProcess);
    if (index >= 0) { _processesToInterrupt.splice(index, 1); }
  });
  _processesToInterrupt.push(childProcess);
}
function interruptChildProcesses() {
  _processesToInterrupt.forEach(function (childProcess, childProcessIndex) {
    childProcess.kill('SIGINT');
  });
  _processesToInterrupt.splice(0, _processesToInterrupt.length);
}

function gitStatusPathPromised(dirpath) {
  return new Promise(function (resolve, reject) {
    var gitProcess = spawn('git', [ 'status', '--untracked-files', '--porcelain', dirpath ], {
      cwd: dirpath,
    });
    var stdout = '';
    var stderr = '';
    gitProcess.stdout.on('data', function (buffer) {
      stdout += buffer.toString();
    });
    gitProcess.stderr.on('data', function (buffer) {
      stderr += buffer.toString();
    });
    gitProcess.on('close', function (code) {
      if (code === 0) {
        resolve(stdout.replace(/\s+$/, '').split('\n').map(function (gitStatusLine) {
          var gitStatusLineParts = gitStatusLine.replace(/^\s+/, '').split(/\s+/);
          if (!gitStatusLineParts[1]) { return null; }
          return {
            status: gitStatusLineParts[0],
            filepath: gitStatusLineParts[1],
          };
        }).filter(function (x) { return !!x; }));
      }
      else if (code === null) {
        var errorToThrow = new Error('git status failed: interrupted.');
        errorToThrow.name = 'ZmeyGorynychError';
        reject(errorToThrow);
      }
      else {
        var errorToThrow = new Error('git status failed: code ' + code + '\n' + stdout + '\n' + stderr);
        errorToThrow.name = 'ZmeyGorynychError';
        reject(errorToThrow);
      }
    });
    makeChildProcessInterruptible(gitProcess);
  });
}

function makeDirectoryIfNotExistsPromised(dirpath) {
  return new Promise(function (resolve, reject) {
    fs.mkdir(dirpath, function (error) {
      if (error && error.code !== 'EEXIST') {
        reject(error);
      }
      else {
        resolve();
      }
    });
  });
}

function makeDirectoryDeepPromised(dirpath) {
  var dirpathQueue = [ dirpath ];

  var dirpathParsed = path.parse(dirpath);
  while (dirpathParsed.dir !== dirpathParsed.root) {
    dirpathQueue.unshift(dirpathParsed.dir);
    dirpathParsed = path.parse(dirpathParsed.dir);
  }

  var promise = Promise.resolve();
  while (dirpathQueue.length > 0) {
    promise = promise.then((function (dirpathNext) {
      return function () {
        return makeDirectoryIfNotExistsPromised(dirpathNext);
      };
    })(dirpathQueue.shift()));
  }

  return promise;
}

function writePackageJson(packageJsonPath, packageJson) {
  var packageJsonString = (JSON.stringify(packageJson, null, 2) + '\n');
  return writeFilePromised(packageJsonPath, packageJsonString);
}

function npmPromised(cwdpath, npmArgs) {
  return new Promise(function (resolve, reject) {
    var npmProcess = spawn('npm', npmArgs, {
      cwd: cwdpath,
    });
    var stdout = '';
    var stderr = '';
    npmProcess.stdout.on('data', function (buffer) {
      stdout += buffer.toString();
    });
    npmProcess.stderr.on('data', function (buffer) {
      stderr += buffer.toString();
    });
    npmProcess.on('close', function (code) {
      if (code === 0) {
        resolve({
          code: code,
          stdout: stdout,
          stderr: stderr,
        });
      }
      else if (code === null) {
        var errorToThrow = new Error('npm ' + npmArgs.join(' ') + ' failed: interrupted.');
        errorToThrow.name = 'ZmeyGorynychError';
        reject(errorToThrow);
      }
      else {
        var errorToThrow = new Error('npm ' + npmArgs.join(' ') + ' failed: code ' + code + '\n' + stdout + '\n' + stderr);
        errorToThrow.name = 'ZmeyGorynychError';
        errorToThrow.code = code;
        errorToThrow.stdout = stdout;
        errorToThrow.stderr = stderr;
        reject(errorToThrow);
      }
    });
    makeChildProcessInterruptible(npmProcess);
  });
}


var _latestVersionsCache = {};

function getLatestVersionFromNpm(packageName) {
  if (_latestVersionsCache[packageName]) {
    return Promise.resolve(_latestVersionsCache[packageName]);
  }
  return npmPromised(CWD, [
    'view', packageName + '@latest', 'version',
  ]).then(function (result) {
    var latestVersion = _latestVersionsCache[packageName] = String(result.stdout).trim();
    return latestVersion;
  });
}


var CWD = process.cwd();
var TEMP_PATH = path.join(CWD, '.zmey-gorynych-temp');
var VERIFY_ROOT_PATH = path.join(TEMP_PATH, 'verify');
var PUBLISH_ROOT_PATH = path.join(TEMP_PATH, 'registry');

var rootError = null;
var rootTask = null;
var rootTaskError = null;
var interrupted = false;
var exiting = false;
var ctx = {};


function renderTitle() {
  var packageCount = ((ctx.packageInfos && ctx.packageInfos.length) || 0);
  return (
    (
      'zmey-gorynych ' +
      (packageCount <= 0
        ? 'found ' + chalk.bold(chalk.red('no'))
        : 'found ' + chalk.bold(chalk.magenta(packageCount))
      ) +
      ' publishable ' + (packageCount > 1 ? 'packages' : 'package') +
      (program.glob ? ' matching ' + chalk.magenta(program.glob) : '') +
      ' in ' + chalk.white(preparePathForDisplay(CWD))
    ) +
    (interrupted && !exiting ? chalk.grey(' - ') + chalk.red('interrupting...') : '')
  );
}


function processPackage(packageInfo, reportProgress, ctxAll) {
  ctxAll.packages = ctxAll.packages || {};
  var packageCtx = ctxAll.packages[packageInfo.dirpath] = ctxAll.packages[packageInfo.dirpath] || {};

  packageCtx.packageInfo = packageInfo;

  function hasInterrupted() {
    if (interrupted) {
      reportProgress('interrupted.');
      return true;
    }
    return false;
  }

  function skipUnverified() {
    return !packageCtx.packageVerified;
  }

  function skipUnchanged() {
    return (program.gitChangedOnly && !packageCtx.hasUncommittedChanges);
  }

  function verifyPackage() {
    reportProgress('verifying package...');

    packageCtx.packageLocalPublishRootPath = path.join(PUBLISH_ROOT_PATH, packageInfo.packageJson.name.replace(/^[^\/]+\//, ''));
    packageCtx.packageVerifyRootPath = path.join(VERIFY_ROOT_PATH, packageInfo.packageJson.name.replace(/^[^\/]+\//, ''));

    // NOTE(@sompylasar): For now, the verification is a no-op.
    packageCtx.packageVerified = true;
  }

  function checkGitStatus() {
    reportProgress('checking git status...');

    return gitStatusPathPromised(packageInfo.dirpath).then(function (gitStatus) {
      packageCtx.hasUncommittedChanges = (gitStatus.length > 0);

      reportProgress(
        packageCtx.hasUncommittedChanges
          ? (gitStatus.length > 1 ? gitStatus.length + ' changes' : '1 change') + ' found via git.'
          : 'no changes found via git.'
      );
    });
  }

  function downloadLatestVersion() {
    reportProgress('downloading the latest version to compare with...');

    return Promise.resolve()
      .then(function () {
        reportProgress('removing temporary directory...');
        return removeDirectoryPromised(packageCtx.packageVerifyRootPath);
      })
      .then(function () {
        reportProgress('creating temporary directory...');
        return makeDirectoryDeepPromised(packageCtx.packageVerifyRootPath);
      })
      .then(function () {
        reportProgress('downloading the latest version into temporary directory...');
        var packageName = packageCtx.packageInfo.packageJson.name;
        return downloadNpmPackage({
          arg: packageName + '@latest',
          dir: packageCtx.packageVerifyRootPath,
        }).then(function () {
          packageCtx.localInstallPackagePath = path.join(packageCtx.packageVerifyRootPath, packageName);
          packageCtx.localInstallPackageJsonPath = path.join(packageCtx.localInstallPackagePath, 'package.json');
          return readFilePromised(packageCtx.localInstallPackageJsonPath)
            .then(function (buffer) {
              packageCtx.localInstallPackageJson = Object.assign({}, JSON.parse(buffer.toString()), {
                scripts: {}
              });
              packageCtx.localInstallVersion = packageCtx.localInstallPackageJson.version;
              _latestVersionsCache[packageName] = packageCtx.localInstallVersion;
              reportProgress('downloaded the latest version to compare with: ' + packageCtx.localInstallPackageJson.version);
            });
        }).catch(function (error) {
          packageCtx.localInstallPackagePath = null;
          packageCtx.localInstallPackageJsonPath = null;
          packageCtx.localInstallPackageJson = null;
          packageCtx.localInstallVersion = null;
          reportProgress('faield to download the latest version.');
          throw error;
        });
      });
  }

  function verifyBuildAfterInstall() {
    reportProgress('verifying the prepared package...');

    return Promise.all(packageInfo.packageJson.files.map(function (filesContainer) {
      var builtVersionPath = path.join(packageInfo.dirpath, filesContainer);
      return lstatPromised(builtVersionPath)
        .catch(function (error) {
          if (error.code === 'ENOENT') {
            var errorToThrow = new Error(
              'Missing files for publish: `' + filesContainer + '`. ' +
              'Probably, `npm install` does not trigger the build.'
            );
            errorToThrow.name = 'ZmeyGorynychError';
            throw errorToThrow;
          }
          else {
            var errorToThrow = new Error(
              'Failed to verify required files for publish: `' + filesContainer + '`. ' +
              error.message
            );
            errorToThrow.name = 'ZmeyGorynychError';
            throw errorToThrow;
          }
        });
    })).then(function () {
      reportProgress('verified the prepared package.');
    });
  }

  function buildPackageFromSource() {
    reportProgress('installing the dependencies and preparing the package...');

    return npmPromised(packageInfo.dirpath, [
      'install',
    ]).then(function () {
      reportProgress('installed the dependencies.');
      return verifyBuildAfterInstall();
    });
  }

  function writeLocalPublishPackageJson() {
    var localPublishPackageJson = Object.assign({}, packageInfo.packageJson, {
      scripts: {}
    });
    var localPublishPackageJsonPath = path.join(packageCtx.packageLocalPublishRootPath, 'package.json');
    return writePackageJson(localPublishPackageJsonPath, localPublishPackageJson).then(function () {
      packageCtx.localPublishPackageJson = localPublishPackageJson;
    });
  }

  function publishLocal() {
    reportProgress('publishing the package to the temporary directory...');
    return Promise.resolve()
      .then(function () {
        reportProgress('removing temporary directory...');
        return removeDirectoryPromised(packageCtx.packageLocalPublishRootPath);
      })
      .then(function () {
        reportProgress('creating temporary directory...');
        return makeDirectoryDeepPromised(packageCtx.packageLocalPublishRootPath);
      })
      .then(function () {
        reportProgress('copying files like publish...');
        return Promise.all(packageInfo.packageJson.files.map(function (filesContainer) {
          var builtVersionPath = path.join(packageInfo.dirpath, filesContainer);
          var localPublishFilesPath = path.join(packageCtx.packageLocalPublishRootPath, filesContainer);
          return new Promise(function (resolve, reject) {
            fs.copy(builtVersionPath, localPublishFilesPath, {
              overwrite: true,
              errorOnExist: false,
              dereference: false,
            }, function (error) {
              if (error) { reject(error); }
              else { resolve(); }
            });
          }).catch(function (error) {
            var errorToThrow = new Error(
              'Failed to copy files for publish: `' + filesContainer + '`. ' +
              error.message
            );
            errorToThrow.name = 'ZmeyGorynychError';
            throw errorToThrow;
          });
        })).then(function () {
          return writeLocalPublishPackageJson();
        }).then(function () {
          reportProgress('published to temporary directory.');
        });
      });
  }

  function compareLocalPublishWithLocalInstall() {
    reportProgress('comparing the published package files with the installed package files...');

    function compare() {
      if (!packageCtx.localInstallPackagePath) {
        return Promise.resolve({
          same: false,
          diffs: [],
        });
      }
      return Promise.all(packageInfo.packageJson.files.map(function (filesContainer) {
        var localInstallFilesPath = path.join(packageCtx.localInstallPackagePath, filesContainer);
        var localPublishFilesPath = path.join(packageCtx.packageLocalPublishRootPath, filesContainer);
        return dircompare.compare(localInstallFilesPath, localPublishFilesPath, {
          compareSize: true,
        });
      })).then(function (dircompareResults) {
        var diffs = [];

        diffs.push({
          relativePath: 'package.json',
          jsdiff: JsDiff.structuredPatch(
            'package.json',
            'package.json',
            JSON.stringify(packageCtx.localInstallPackageJson, null, 2),
            JSON.stringify(packageCtx.localPublishPackageJson, null, 2),
            '',
            ''
          ),
        });

        diffs.push.apply(diffs, dircompareResults.reduce(function (accu, dircompareResult) {
          return accu.concat(dircompareResult.diffSet.filter(function (diff) {
            return (diff.state !== 'equal' && !/\.map$/.test(diff.name1));
          }));
        }, []).map(function (diff) {
          var path1 = (diff.path1 ? path.join(diff.path1, diff.name1) : undefined);
          var path2 = (diff.path2 ? path.join(diff.path2, diff.name2) : undefined);
          var relativePath = (
            path1
              ? path.relative(packageCtx.localInstallPackagePath, path1)
              : (
                path2
                  ? path.relative(packageCtx.packageLocalPublishRootPath, path2)
                  : undefined
              )
          );
          if (!relativePath) {
            return {
              relativePath: undefined,
              jsdiff: undefined,
            };
          }
          var content1 = (path1 ? String(fs.readFileSync(path1)) : '');
          var content2 = (path2 ? String(fs.readFileSync(path2)) : '');
          return {
            relativePath: relativePath,
            jsdiff: JsDiff.structuredPatch(
              relativePath,
              relativePath,
              content1,
              content2,
              '',
              ''
            ),
          };
        }));

        diffs = diffs.filter(function (diff) {
          return (diff.jsdiff && diff.jsdiff.hunks.length > 0);
        });

        return {
          same: (diffs.length <= 0),
          diffs: diffs,
        };
      }).catch(function (ex) {
        debug(ex.stack);
        throw ex;
      });
    }

    return compare().then(function (compareResult) {
      packageCtx.compareResult = compareResult;
      if (!compareResult.same) {
        // https://www.npmjs.com/package/semver#functions
        var localInstallVersion = (packageCtx.localInstallVersion || '0.0.0');
        var suggestedVersionBumpType = (semver.prerelease(localInstallVersion)
          ? 'prerelease'
          : 'major'
        );
        var suggestedVersion = semver.inc(localInstallVersion, suggestedVersionBumpType).replace(/-0$/, '');
        packageCtx.suggestedVersion = suggestedVersion;

        // If not bumped already, suggest a bump.
        if (!semver.lt(packageInfo.packageJson.version, suggestedVersion)) {
          packageCtx.alreadyBumped = true;
        }
        else if (program.bump || program.publish) {
          var packageJsonBumped = Object.assign({}, packageInfo.packageJson, {
            version: suggestedVersion,
          });

          return writePackageJson(packageInfo.packageJsonPath, packageJsonBumped)
            .then(function () {
              packageCtx.alreadyBumped = true;
              packageCtx.writtenBump = true;
              packageInfo.packageJson = packageJsonBumped;

              // Refresh the diffs.
              compareResult.diffs.forEach(function (diff) {
                if (diff.relativePath === 'package.json') {
                  diff.jsdiff = JsDiff.structuredPatch(
                    'package.json',
                    'package.json',
                    JSON.stringify(packageCtx.localInstallPackageJson, null, 2),
                    JSON.stringify(packageJsonBumped, null, 2),
                    '',
                    ''
                  );
                }
              });

              // Update the locally published `package.json`.
              // NOTE(@sompylasar): This assumes the build process does not use the version in `package.json`.
              return writeLocalPublishPackageJson();
            })
            .then(function () {
              reportProgress('compared, found changes and bumped version in package.json file.');
            });
        }

        reportProgress('compared, found changes.');
      }
      else {
        reportProgress('compared, no changes.');
      }
    });
  }

  function getLatestVersionsOfDependencies() {
    if (!program.updates) { return Promise.resolve(); }
    if (!packageCtx.localPublishPackageJson) { return Promise.resolve(); }

    reportProgress('checking for available updates in npm...');

    var currentDependencies = packageCtx.localPublishPackageJson.dependencies || {};
    var currentDevDependencies = packageCtx.localPublishPackageJson.devDependencies || {};
    packageCtx.latestDependencies = {};
    packageCtx.latestDevDependencies = {};

    function makeUpdateItem(currentDependencies, latestDependencies, packageName) {
      var currentVersion = currentDependencies[packageName];
      var latestVersion = latestDependencies[packageName];
      if (!semver.satisfies(latestVersion, currentVersion)) {
        return {
          packageName: packageName,
          currentVersion: currentVersion,
          latestVersion: latestVersion,
        };
      }
      else {
        return null;
      }
    }

    return Promise.all([
      Promise.all(Object.keys(currentDependencies).map(function (packageName) {
        return getLatestVersionFromNpm(packageName).then(function (latestVersion) {
          packageCtx.latestDependencies[packageName] = latestVersion;
        });
      })).then(function () {
        packageCtx.updates = Object.keys(packageCtx.latestDependencies)
          .map(makeUpdateItem.bind(null, currentDependencies, packageCtx.latestDependencies))
          .filter(function (x) { return !!x; });
      }),
      Promise.all(Object.keys(currentDevDependencies).map(function (packageName) {
        return getLatestVersionFromNpm(packageName).then(function (latestVersion) {
          packageCtx.latestDevDependencies[packageName] = latestVersion;
        });
      })).then(function () {
        packageCtx.updatesDev = Object.keys(packageCtx.latestDevDependencies)
          .map(makeUpdateItem.bind(null, currentDevDependencies, packageCtx.latestDevDependencies))
          .filter(function (x) { return !!x; });
      }),
    ]);
  }

  return Promise.resolve()
    .then(function () {
      return verifyPackage();
    })
    .then(function () {
      if (hasInterrupted()) { return; }
      if (skipUnverified()) { return; }
      if (program.gitChangedOnly) {
        return checkGitStatus()
          .then(function () {
            if (skipUnchanged()) {
              packageCtx.skippedNoSourceChanges = true;
              reportProgress('skipped, no source changes.');
            }
          });
      }
    })
    .then(function () {
      if (hasInterrupted()) { return; }
      if (skipUnverified()) { return; }
      if (skipUnchanged()) { return; }
      return downloadLatestVersion();
    })
    .then(function () {
      if (hasInterrupted()) { return; }
      if (skipUnverified()) { return; }
      if (skipUnchanged()) { return; }
      if (program.upgrade) {
        reportProgress('upgrading the dependencies...');

        var isKnownPackage = function (packageName) {
          return ctxAll.packageInfos.some(function (packageInfo) {
            return (packageInfo.packageJson.name === packageName);
          });
        };

        var upgradeDependencies = function (dependencies) {
          if (!dependencies) { return Promise.resolve(dependencies); }

          var packageNames = Object.keys(dependencies).filter(isKnownPackage);
          if (packageNames.length <= 0) { return Promise.resolve(dependencies); }

          return Promise.all(packageNames.map(function (packageName) {
            return getLatestVersionFromNpm(packageName);
          })).then(function (packageVersions) {
            var dependenciesUpgraded = Object.assign({}, dependencies);
            var changed = false;
            packageNames.forEach(function (packageName, index) {
              var latestVersion = packageVersions[index];
              if (semver.gtr(latestVersion, dependencies[packageName])) {
                dependenciesUpgraded[packageName] = latestVersion;
                changed = true;
              }
            });
            return (changed ? dependenciesUpgraded : dependencies);
          });
        };

        var packageJsonUpgraded = Object.assign({}, packageInfo.packageJson);

        return Promise.all([
          upgradeDependencies(packageInfo.packageJson.dependencies)
            .then(function (dependenciesUpgraded) {
              packageJsonUpgraded.dependencies = dependenciesUpgraded;
            }),
          upgradeDependencies(packageInfo.packageJson.devDependencies)
            .then(function (devDependenciesUpgraded) {
              packageJsonUpgraded.devDependencies = devDependenciesUpgraded;
            }),
        ]).then(function () {
          if (
            packageJsonUpgraded.dependencies === packageInfo.packageJson.dependencies &&
            packageJsonUpgraded.devDependencies === packageInfo.packageJson.devDependencies
          ) {
            return;
          }

          return writePackageJson(packageInfo.packageJsonPath, packageJsonUpgraded)
            .then(function () {
              packageInfo.packageJson = packageJsonUpgraded;
            });
        });
      }
    })
    .then(function () {
      if (hasInterrupted()) { return; }
      if (skipUnverified()) { return; }
      if (skipUnchanged()) { return; }
      return buildPackageFromSource();
    })
    .then(function () {
      if (hasInterrupted()) { return; }
      if (skipUnverified()) { return; }
      if (skipUnchanged()) { return; }
      return publishLocal();
    })
    .then(function () {
      if (hasInterrupted()) { return; }
      if (skipUnverified()) { return; }
      if (skipUnchanged()) { return; }
      return compareLocalPublishWithLocalInstall();
    })
    .then(function () {
      if (hasInterrupted()) { return; }
      if (skipUnverified()) { return; }
      if (skipUnchanged()) { return; }
      return getLatestVersionsOfDependencies();
    })
    .then(function () {
      if (hasInterrupted()) { return; }
      if (skipUnverified()) { return; }
      if (skipUnchanged()) { return; }
      if (!packageCtx.compareResult.same) {
        if (packageCtx.writtenBump) {
          reportProgress('found changes, bumped version.');
        }
        else if (packageCtx.alreadyBumped) {
          reportProgress('found changes, version already bumped.');
        }
        else {
          reportProgress('found changes.');
        }
        if (program.publish) {
          reportProgress('publishing...');
          return npmPromised(packageInfo.dirpath, [
            'publish',
          ])
            .then(function () {
              packageCtx.publishedVersion = packageInfo.packageJson.version;
              delete _latestVersionsCache[packageInfo.packageJson.name];
              reportProgress('published.');
            })
            .then(function () {
              return publishLocal();
            })
            .then(function () {
              reportProgress('published.');
            });
        }
      }
      else {
        reportProgress('no changes.');
      }
    });
}

function getListOfPackages(ctx, reportProgress) {
  reportProgress('looking for packages...');
  return Promise.resolve()
    .then(function () {
      reportProgress('checking if ' + preparePathForDisplay(CWD) + ' contains a package...');
      return getPackageInfosPromised([ CWD ]);
    })
    .then(function (packageInfos) {
      if (packageInfos.length === 1) {
        reportProgress('found single package in ' + preparePathForDisplay(CWD));
        ctx.packageInfos = packageInfos;
        return;
      }

      reportProgress('looking into subdirectories of ' + preparePathForDisplay(CWD));
      return getChildInfosPromised(CWD)
        .then(function (childInfos) {
          ctx.childpaths = childInfos.map(function (childInfo) {
            var match = (!program.glob || minimatch(childInfo.childname, program.glob));
            if (!match) {
              return null;
            }
            if (childInfo.lstat.isDirectory()) {
              return childInfo.childpath;
            }
            else {
              return null;
            }
          }).filter(function (x) { return !!x; });
        })
        .then(function (childpaths) {
          reportProgress('looking for packages in subdirectories of ' + preparePathForDisplay(CWD));
          return getPackageInfosPromised(ctx.childpaths).then(function (packageInfos) {
            ctx.packageInfos = packageInfos;
          });
        });
    });
}

function renderPackageTitle(name, text) {
  return (
    chalk.cyan(name) +
    (text ? ' - ' + text : '')
  );
}

function done() {
  var attentionCount = 0;

  return Promise.resolve()
    .then(function () {
      if (rootError !== rootTaskError) { return; }

      ctx.packageInfos.forEach(function (packageInfo) {
        var packageDirpath = packageInfo.dirpath;
        var error = packageInfo.error;

        var isWarning = false;
        var firstLineString = '';
        var otherLinesString = '';

        if (error) {
          otherLinesString += (
            '\n' +
            chalk.red('     → ' +
              (error.name !== 'Error' && error.name !== 'ZmeyGorynychError' ? error.name + ': ' : '') +
              error.message
            ) +
            '\n' +
            (error.name !== 'ZmeyGorynychError'
              ? chalk.grey(
                String(error.stack).replace(/^.*\n/, '').replace(/^\s*/gm, '         ')
              )
              : ''
            )
          );
        }

        var packageCtx = ctx.packages[packageDirpath];
        if (packageCtx && packageCtx.compareResult) {
          var compareResult = packageCtx.compareResult;
          var suggestedVersionBump = (!compareResult.same && !packageCtx.alreadyBumped);

          if (suggestedVersionBump) {
            isWarning = true;
          }

          if (packageCtx.publishedVersion) {
            firstLineString = chalk.green('published: ' + chalk.bold(packageCtx.publishedVersion));
          }
          else {
            firstLineString = (compareResult.same
              ? chalk.green('no version bump: ' + chalk.bold(packageInfo.packageJson.version))
              : (packageCtx.alreadyBumped
                ? chalk.yellow('version bumped, need publish: ' + chalk.bold(packageCtx.localInstallVersion) + ' → ' + chalk.bold(packageInfo.packageJson.version))
                : chalk.yellow(
                  'suggested version bump: ' +
                  chalk.bold(packageInfo.packageJson.version) + ' → ' +
                  chalk.bold(packageCtx.suggestedVersion)
                )
              )
            );
          }

          if (program.diff && compareResult.diffs.length > 0) {
            otherLinesString += (
              '\n' +
              compareResult.diffs.reduce(function (accu, diff) {
                return accu.concat(
                  diff.jsdiff.hunks.reduce(function (accu, hunk) {
                    return accu.concat([
                      '\n' + chalk.magenta('./' + diff.relativePath) + chalk.grey(
                        ' @ ' +
                        '' + hunk.oldStart + '-' + (hunk.oldStart + hunk.oldLines) + ' → ' +
                        '' + hunk.newStart + '-' + (hunk.newStart + hunk.newLines)
                      ),
                    ]).concat(
                      hunk.lines.map(function (line) {
                        return (line.charAt(0) === '-'
                          ? chalk.red(line)
                          : (line.charAt(0) === '+'
                            ? chalk.green(line)
                            : (line)
                          )
                        );
                      })
                    );
                  }, [])
                );
              }, []).join('\n') +
              '\n'
            );
          }
        }
        else if (packageCtx && packageCtx.skippedNoSourceChanges) {
          firstLineString = chalk.grey('skipped, no source changes.');
        }
        else if (interrupted) {
          firstLineString = chalk.grey('interrupted.');
          isWarning = true;
        }

        if (error && !firstLineString) {
          firstLineString = chalk.red('error.');
        }

        if (program.updates && packageCtx && (packageCtx.updates.length > 0 || packageCtx.updatesDev.length > 0)) {
          var makeUpdateLine = function (updateItem) {
            return ('       ' + updateItem.packageName + ': ' + chalk.bold(updateItem.currentVersion) + ' → ' + chalk.bold(updateItem.latestVersion));
          };

          otherLinesString += (
            '\n\n' +
            [
              (packageCtx.updates.length > 0 ? '     ' + chalk.grey('Updates available for dependencies:') + '\n' +
              packageCtx.updates.map(makeUpdateLine).join('\n') : ''),
              (packageCtx.updatesDev.length > 0 ? '     ' + chalk.grey('Updates available for devDependencies:') + '\n' +
              packageCtx.updatesDev.map(makeUpdateLine).join('\n') : ''),
            ].filter(function (x) { return !!x; }).join('\n') +
            '\n'
          );
        }

        var resultCharacter = chalk.green('✔');
        if (error) {
          resultCharacter = chalk.red('✖');
          ++attentionCount;
        }
        else if (isWarning) {
          resultCharacter = chalk.yellow('⚠');
          ++attentionCount;
        }

        console.log(
          '   ' + resultCharacter + ' ' +
          renderPackageTitle(packageInfo.packageJson.name, firstLineString) +
          otherLinesString
        );
      });

      console.log('\n');
    })
    .then(function () {
      if (program.keepTemp) {
        // Keep the temporary directory for investigation.
        return;
      }
      else {
        return removeDirectoryPromised(TEMP_PATH);
      }
    })
    .then(function () {
      exiting = true;
      if (rootTask) { rootTask.title = renderTitle(); }
      if (attentionCount > 0) {
        process.exit(1);
      }
      else {
        process.exit(0);
      }
    })
    .catch(function (error) {
      rootError = rootError || error;
    })
    .then(function () {
      if (rootError) {
        if (rootError !== rootTaskError) {
          console.error(rootError);
        }
        process.exit(2);
      }
    });
}

function doneAsync(error) {
  process.nextTick(done);
}

function interrupt() {
  interrupted = true;
  interruptChildProcesses();
  if (rootTask) { rootTask.title = renderTitle(); }
}


function printIntro() {
  if (!program.intro) { return; }

  var npmVersion = null;

  return Promise.resolve()
    .then(function () {
      return npmPromised(CWD, [ '--version' ]).then(function (result) {
        npmVersion = String(result.stdout).trim();
      });
    })
    .then(function () {
      // http://ascii.co.uk/art/dragon
      console.log([
        "",
        "                                                         ____________",
        "                                   (`-..________....---''  ____..._.-`",
        "                                    \\\\`._______.._,.---'''     ,'",
        "                                    ; )`.      __..-'`-.      /",
        "                                   / /     _.-' _,.;;._ `-._,'",
        "                                  / /   ,-' _.-'  //   ``--._``._",
        "                                ,','_.-' ,-' _.- (( =-    -. `-._`-._____",
        "                              ,;.''__..-'   _..--.\\\\.--'````--.._``-.`-._`.",
        "               _          |\\,' .-''        ```-'`---'`-...__,._  ``-.`-.`-.`.",
        "    _     _.-,'(__)\\__)\\-'' `     ___  .          `     \\      `--._",
        "  ,',)---' /|)          `     `      ``-.   `     /     /     `     `-.",
        "  \\_____--.  '`  `               __..-.  \\     . (   < _...-----..._   `.",
        "   \\_,--..__. \\\\ .-`.\\----'';``,..-.__ \\  \\      ,`_. `.,-'`--'`---''`.  )",
        "             `.\\`.\\  `_.-..' ,'   _,-..'  /..,-''(, ,' ; ( _______`___..'__",
        "                     ((,(,__(    ((,(,__,'  ``'-- `'`.(\\  `.,..______   SSt",
        "                                                        ``--------..._``--.__",
        "   " + ('node ' + chalk.bold(process.versions.node)) + "   " + ('npm ' + chalk.bold(npmVersion)),
        "",
      ].join('\n'));
    });
}


process.stdin.setRawMode(true);
process.stdin.resume();
CtrlC.onPress = function () {
  interrupt();
};


Promise.resolve()
  .then(function () {
    return printIntro();
  })
  .then(function () {
    return removeDirectoryPromised(TEMP_PATH);
  })
  .then(function () {
    function reportProgress() {}
    return getListOfPackages(ctx, reportProgress);
  })
  .then(function () {
    if (!ctx.packageInfos || ctx.packageInfos.length <= 0) {
      console.log(renderTitle());
      return;
    }

    return new Listr([
      {
        title: renderTitle(),
        task: function (ctx, task) {
          rootTask = task;
          return new Listr(
            ctx.packageInfos.map(function (packageInfo) {
              return {
                title: packageInfo.packageJson.name,
                task: function (ctx, task) {
                  return processPackage(
                    packageInfo,
                    function (progressText) {
                      var title = renderPackageTitle(packageInfo.packageJson.name, chalk.grey(progressText || '...'));
                      if (title !== task.title) {
                        task.title = title;
                      }
                    },
                    ctx
                  ).then(function () {
                    if (rootTask) {
                      var title = renderTitle();
                      if (title !== rootTask.title) {
                        rootTask.title = title;
                      }
                    }
                  }).catch(function (error) {
                    task.title = renderPackageTitle(packageInfo.packageJson.name, chalk.red('error.'));
                    packageInfo.error = error;
                  });
                },
              };
            }),
            {
              concurrent: true,
              exitOnError: false,
            }
          );
        },
      },
    ], {
      collapse: true,
      renderer: (debug.enabled ? ListrVerboseRenderer : ListrMultilineRenderer),
    }).run(ctx).catch(function (error) {
      rootTaskError = error;
    });
  })
  .catch(function (error) {
    rootError = error;
  })
  .then(doneAsync);
