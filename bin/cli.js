#!/bin/env node

var fs = require('fs-extra');
var path = require('path');
var spawn = require('child_process').spawn;
var chalk = require('chalk');
var rimraf = require('rimraf');
var dircompare = require('dir-compare');
var Listr = require('listr');
var ListrMultilineRenderer = require('listr-multiline-renderer');
var semver = require('semver');
var downloadNpmPackage = require('download-npm-package');
var JsDiff = require('diff');
var program = require('commander');
var minimatch = require('minimatch');
var CtrlC = require("ctrl-c");

program
  .option('--glob <wildcard>', 'Only process the matching packages (handled by `minimatch`).')
  .option('--diff', 'Print package content diffs.')
  .option('--updates', 'Print package dependency updates.')
  .option('--bump', 'Bump the versions in package.json files to the suggested versions.')
  .option('--upgrade', 'Upgrade versions of known packages in all packages.')
  .option('--publish', 'Bump the versions in package.json files to the suggested versions and publish to npm.')
  .option('--intro', 'Show the intro picture.')
  .parse(process.argv);


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
        const packageJson = packageInfo.packageJson;
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

function gitStatusPathPromised(dirpath) {
  return new Promise(function (resolve, reject) {
    var gitProcess = spawn('git', [ 'status', '--untracked-files', '--porcelain', dirpath ]);
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
      else {
        reject(new Error('git status failed: code ' + code + '\n' + stdout + '\n' + stderr));
      }
    });
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
  var packageJsonString = JSON.stringify(packageJson, null, 2);
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
      else {
        var error = new Error('npm ' + npmArgs.join(' ') + ' failed: code ' + code + '\n' + stdout + '\n' + stderr);
        error.code = code;
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      }
    });
  });
}


var _latestVersionsCache = {};

function getLatestVersionFromNpm(packageName) {
  if (_latestVersionsCache[packageName]) {
    return Promise.resolve(_latestVersionsCache[packageName]);
  }
  return npmPromised(TEMP_PATH, [
    'view', packageName + '@latest', 'version',
  ]).then(function (result) {
    var latestVersion = _latestVersionsCache[packageName] = String(result.stdout).trim();
    return latestVersion;
  });
}


var CWD = process.cwd();
var TEMP_PATH = path.join(CWD, '.zmey-gorynich-temp');
var VERIFY_ROOT_PATH = path.join(TEMP_PATH, 'verify');
var PUBLISH_ROOT_PATH = path.join(TEMP_PATH, 'registry');

var interrupt = false;


function processPackage(packageInfo, reportProgress, ctxAll) {
  ctxAll.packages = ctxAll.packages || {};
  var packageCtx = ctxAll.packages[packageInfo.dirpath] = ctxAll.packages[packageInfo.dirpath] || {};

  packageCtx.packageInfo = packageInfo;

  function hasInterrupted() {
    if (interrupt) {
      reportProgress('interrupted.');
      return true;
    }
    return false;
  }

  function skipUnverified() {
    return !packageCtx.packageVerified;
  }

  function verifyPackage() {
    reportProgress('verifying package...');

    packageCtx.packageLocalPublishRootPath = path.join(PUBLISH_ROOT_PATH, packageInfo.packageJson.name.replace(/^[^\/]+\//, ''));
    packageCtx.packageVerifyRootPath = path.join(VERIFY_ROOT_PATH, packageInfo.packageJson.name.replace(/^[^\/]+\//, ''));
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
        });
      });
  }

  function buildPackageFromSource() {
    reportProgress('installing the dependencies and building the package...');

    return npmPromised(packageInfo.dirpath, [
      'install',
    ]).then(function () {
      reportProgress('built the package.');
    });
  }

  function writeLocalPublishPackageJson() {
    var localPublishPackageJson = Object.assign({}, packageInfo.packageJson, {
      scripts: {}
    });
    return writeFilePromised(
      path.join(packageCtx.packageLocalPublishRootPath, 'package.json'),
      JSON.stringify(localPublishPackageJson, null, 2)
    ).then(function () {
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
          dircompareResults: [],
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
          var path1 = path.join(diff.path1, diff.name1);
          var path2 = path.join(diff.path2, diff.name2);
          var relativePath = path.relative(packageCtx.localInstallPackagePath, path1);
          var content1 = String(fs.readFileSync(path1));
          var content2 = String(fs.readFileSync(path2));
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
          return (diff.jsdiff.hunks.length > 0);
        });

        return {
          same: (diffs.length <= 0),
          diffs: diffs,
        };
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
      return checkGitStatus();
    })
    .then(function () {
      if (hasInterrupted()) { return; }
      if (skipUnverified()) { return; }
      return downloadLatestVersion();
    })
    .then(function () {
      if (hasInterrupted()) { return; }
      if (program.upgrade) {
        reportProgress('upgrading the dependencies...');

        function isKnownPackage(packageName) {
          return ctxAll.packageInfos.some(function (packageInfo) {
            return (packageInfo.packageJson.name === packageName);
          });
        }

        function upgradeDependencies(dependencies) {
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
        }

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
      return buildPackageFromSource();
    })
    .then(function () {
      if (hasInterrupted()) { return; }
      if (skipUnverified()) { return; }
      return publishLocal();
    })
    .then(function () {
      if (hasInterrupted()) { return; }
      if (skipUnverified()) { return; }
      return compareLocalPublishWithLocalInstall();
    })
    .then(function () {
      if (hasInterrupted()) { return; }
      if (skipUnverified()) { return; }
      return getLatestVersionsOfDependencies();
    })
    .then(function () {
      if (hasInterrupted()) { return; }
      if (skipUnverified()) { return; }
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
  reportProgress('getting the list of packages...');
  return Promise.resolve()
    .then(function () {
      reportProgress('getting subdirectories of ./' + path.relative(process.cwd(), CWD));
      return getChildInfosPromised(CWD).then(function (childInfos) {
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
      });
    })
    .then(function (childpaths) {
      reportProgress('getting package infos from subdirectories...');
      return getPackageInfosPromised(ctx.childpaths).then(function (packageInfos) {
        ctx.packageInfos = packageInfos;
      });
    });
}

function removeTempDirectoryPromised(ctx, reportProgress) {
  reportProgress('removing temporary directory ./' + path.relative(process.cwd(), TEMP_PATH));
  return Promise.resolve()
    .then(function () {
      return removeDirectoryPromised(TEMP_PATH);
    });
}


var ctx = {};

function done() {
  var warningsCount = 0;

  return Promise.resolve()
    .then(function () {
      var packageDirpaths = Object.keys(ctx.packages || {});
      packageDirpaths.forEach(function (packageDirpath) {
        var packageCtx = ctx.packages[packageDirpath];

        var isWarning = false;

        var firstLineString = '';
        var otherLinesString = '';

        var compareResult = packageCtx.compareResult;
        if (compareResult) {
          var suggestedVersionBump = (!compareResult.same && !packageCtx.alreadyBumped);

          if (suggestedVersionBump) {
            isWarning = true;
          }

          if (packageCtx.publishedVersion) {
            firstLineString = chalk.green('published: ' + chalk.bold(packageCtx.publishedVersion));
          }
          else {
            firstLineString = (compareResult.same
              ? chalk.green('no version bump: ' + chalk.bold(packageCtx.packageInfo.packageJson.version))
              : (packageCtx.alreadyBumped
                ? chalk.yellow('version bumped, need publish: ' + chalk.bold(packageCtx.localInstallVersion) + ' -> ' + chalk.bold(packageCtx.packageInfo.packageJson.version))
                : chalk.yellow(
                  'suggested version bump: ' +
                  chalk.bold(packageCtx.packageInfo.packageJson.version) + ' -> ' +
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
                        '' + hunk.oldStart + '-' + (hunk.oldStart + hunk.oldLines) + ' -> ' +
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
        else if (interrupt) {
          firstLineString = chalk.grey('interrupted.');
          isWarning = true;
        }

        if (program.updates && (packageCtx.updates.length > 0 || packageCtx.updatesDev.length > 0)) {
          var makeUpdateLine = function (updateItem) {
            return ('       ' + updateItem.packageName + ': ' + chalk.bold(updateItem.currentVersion) + ' -> ' + chalk.bold(updateItem.latestVersion));
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
        if (isWarning) {
          resultCharacter = chalk.yellow('⚠');
          ++warningsCount;
        }

        console.log(
          '   ' + resultCharacter + ' ' + chalk.cyan(packageCtx.packageInfo.packageJson.name) +
          (firstLineString ? ' - ' +  firstLineString : '') +
          otherLinesString
        );
      });

      console.log('\n');
    })
    .then(function () {
      //return removeDirectoryPromised(TEMP_PATH);
    })
    .then(function () {
      if (warningsCount > 0) {
        process.exit(1);
      }
      else {
        process.exit(0);
      }
    })
    .catch(function (error) {
      console.error(error);
      process.exit(2);
    });
}

function doneAsync() {
  process.nextTick(done);
}


function printIntro() {
  if (!program.intro) { return; }
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
    "",
  ].join('\n'));
}


process.stdin.setRawMode(true);
process.stdin.resume();
CtrlC.onPress = function () {
  interrupt = true;
};


Promise.resolve()
  .then(function () {
    printIntro();
  })
  .then(function () {
    function reportProgress() {}
    return getListOfPackages(ctx, reportProgress)
      .then(function () {
        return removeTempDirectoryPromised(ctx, reportProgress);
      });
  })
  .then(function () {
    if (ctx.packageInfos.length <= 0) {
      console.log(
        'No publishable packages' + (program.glob ? ' matching ' + chalk.magenta(program.glob) : '')
      );
      return;
    }

    return new Listr([
      {
        title: 'Found ' + chalk.magenta(ctx.packageInfos.length) + ' publishable packages' + (program.glob ? ' matching ' + chalk.magenta(program.glob) : ''),
        task: function (ctx) {
          return new Listr(
            ctx.packageInfos.map(function (packageInfo) {
              return {
                title: packageInfo.packageJson.name,
                task: function (ctx, task) {
                  return processPackage(packageInfo, function (progressText) {
                    task.title = (
                      chalk.cyan(packageInfo.packageJson.name) +
                      ' - ' +
                      chalk.grey(progressText || '...')
                    );
                  }, ctx);
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
      renderer: ListrMultilineRenderer,
    }).run(ctx);
  })
  .then(doneAsync, doneAsync);
