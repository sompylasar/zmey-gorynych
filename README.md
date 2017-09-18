# Zmey Gorynych

A Node.js package versioning and publishing tool, an alternative to [Lerna](https://github.com/lerna/lerna).

<p align="center">
  <img alt="Zmey Gorynych. Image © Dobrynya Nikitich and Zmey Gorynych, 2006" src="https://user-images.githubusercontent.com/498274/30076044-8c36fa9a-922c-11e7-84e0-87d67cb8ea39.jpg" width="480">
</p>
<p align="center">
  <i>Image © Dobrynya Nikitich and Zmey Gorynych, 2006</i>
</p>

The tool helps to manage versioning and publishing of Node.js packages that are developed together but do not necessarily belong to a single project.

Read more in the [Features](#features) and [Motivation](#motivation) sections.


## Usage

Install as a global tool:
```
npm install -g zmey-gorynych
```

Run the tool from within a directory with packages:
```
zmey
```

Example output:
```
 ✔ Found 2 publishable packages
   ✔ @example-company/some-package - no version bump: 1.0.0-alpha.4
   ✔ @example-company/another-package - suggested version bump: 1.0.0-alpha.2 -> 1.0.0-alpha.3
```

The tool exits with the zero code if no human attention is required, and with a non-zero code otherwise.

See more CLI options by running `zmey --help`.


## Features

- [x] Suggestion to bump the version if the locally published files differ from the files from the latest version published to the registry.
- [x] Show diff between the locally published files and the files from the latest version published to the registry: `--diff`.
- [x] Suggestion to publish if the version is already bumped.
- [x] An option to update the `package.json` files with the suggested versions: `--bump`.
- [x] An option to upgrade the dependencies to the latest versions of the locally developed packages found by the tool: `--upgrade`.
- [x] An option to publish the next version to the npm registry: `--publish`.
- [x] An option to filter the packages being touched by their directory name: `--glob <wildcard>`.

##### Futures

- [ ] Better documentation: ["what it does"](https://github.com/semantic-release/cli/blob/6fe3c63123470d74f522593f36714597ae47b18c/README.md#what-it-does).
- [ ] Smarter scan: support for multiple package locations to look for the locally developed packages.
- [ ] Smarter bump: detect minor changes (e.g. a README, documentation, or comments) and non-breaking changes (e.g. added a new export, added a new file without changing existing ones).
- [ ] Smarter upgrade: recursive without the need to publish intermediate versions.
- [ ] Smarter publish: branch-awareness, [canary, commit-hash versioned](https://github.com/lerna/lerna/blob/54761ba26f8cb6d50d16a4c920d1a9594c19d6e9/README.md#--canary--c) packages.
- [ ] Smarter publish: [no version committed in package.json](https://github.com/semantic-release/semantic-release/blob/8c44c3176af3d41fd87ac9d9b7a1d2f2d441b75f/README.md#why-is-the-packagejsons-version-not-updated-in-my-repository).


## Motivation

An organization can benefit from developing software as Node.js packages because they enable or greatly improve modularity and code reuse.

When the code is in TypeScript or the latest JavaScript, pre-compiling the code into Node.js-compatible or browser-compatible JavaScript is required to reuse it.
Node.js packages and an npm-compatible registry enable one-time build and allow to maintain the build configuration next to the reusable piece of code that requires compilation.

This tool was born as the second step in introducing Node.js packages in an organization which uses TypeScript and modern JavaScript code for Node.js and browser environments.

In the first step to make Node.js package development in the organization even possible, a few changes were implemented:

- An organization-wide npm-compatible private registry was configured.
- A repository which contained many half-baked Node.js packages in a nested directory structure with relative path dependencies was restructured to a flat structure [similar to the one required by Lerna](https://github.com/lerna/lerna#what-does-a-lerna-repo-look-like).
- The `publishConfig.registry` option was added to the `package.json` of each package that was planned to be published or was a dependency of other packages.

The organization legacy that had to be kept in mind at the time of making this tool includes the following:

- The packages can be located in one or more source code repositories; the relative paths to the packages may vary.
- The packages serve more than one application, they are reused across applications, a few are applications of their own; thus, they cannot be versioned together and managed as a part of a single project [like Babel](https://github.com/babel/babel/blob/3cdb7d7f0fffa48a9181ceeb05ede5382b1ab669/doc/design/monorepo.md).
- The packages need to be built and are unusable as `npm link`ed dependencies because of [the type definition resolution of the version of TypeScript in use](https://github.com/Microsoft/TypeScript/issues/6496). This may have changed since, but requires upgrade of TypeScript.
- The source code repositories contain code that uses multiple technologies at the same time. Lerna, on the other hand, assumes the repository is reserved for Node.js packages, [manipulates it with git](https://github.com/lerna/lerna/blob/54761ba26f8cb6d50d16a4c920d1a9594c19d6e9/README.md#publish) and [requires extra effort to prevent this](https://github.com/lerna/lerna/blob/54761ba26f8cb6d50d16a4c920d1a9594c19d6e9/README.md#--skip-git).
- The organization engineers have no objective to maintain internal packages as if they were open-source, unify and groom commit messages, produce nice changelogs.
- The organization engineers have diverse technology backgrounds and have no objective to learn and follow a Node.js-centric development workflow.
- [`semantic-release` requires Node 8](https://github.com/semantic-release/semantic-release/blob/8c44c3176af3d41fd87ac9d9b7a1d2f2d441b75f/README.md#why-does-semantic-release-require-node-version--8) while the organization hasn't yet upgraded.
- Lerna has a buggy command-line interface (ANSI color markers leaking), maybe related to a similar bug of `npm publish` in the version of `npm` in use.

Adding the idealistic, open-source-centric, Node.js-centric [development conventions](https://github.com/commitizen) and [automation tools](https://github.com/semantic-release/semantic-release) 
that are currently being built by the Node.js open-source community turned out to require too much commitment from the engineers that they cannot afford accepting:

- Restructure existing code repositories or create new ones to make them compatible with the open-source community tools. This is unrealistic because the tools should serve the organization, not vice versa.
- Learn many new tools and constantly follow the high pace of updates. This is accepted as a given in Node.js and Frontend communities but feels alien in slower-pace technology communities.
- Implement full [API test](https://github.com/semantic-release/cracks) and [API documentation](https://github.com/bcherny/india) coverage for all packages. This is nice-to-have but unrealistic in an organization with a relatively small engineering team.
- Introduce [the open-source commit message convention](https://conventionalcommits.org/). This is nice-to-have but unrealistic within combined code repositories where not everything follows the open-source way of doing things.
- Maintain internal packages as if they were open-source. This is nice-to-have but not an objective in a product-driven organization.

The above produced the following technical requirements to the tool:

- The tool should automate package-related tasks in a developer-friendly way: require less typing and explain itself clearly.
- The tool should not [require per-repo configuration](https://github.com/lerna/lerna/blob/54761ba26f8cb6d50d16a4c920d1a9594c19d6e9/README.md#lernajson).
- The tool should not [rely on the open-source commit message convention](https://github.com/semantic-release/semantic-release/blob/8c44c3176af3d41fd87ac9d9b7a1d2f2d441b75f/README.md#how-does-it-work).
- The tool should not [rely on commits to determine changes in the packages](https://github.com/lerna/lerna/blob/54761ba26f8cb6d50d16a4c920d1a9594c19d6e9/README.md#updated).
- The tool should not [enforce a source code management workflow (commit, tag)](https://github.com/lerna/lerna/blob/54761ba26f8cb6d50d16a4c920d1a9594c19d6e9/README.md#publish).
- The tool should allow [independent versioning](https://github.com/lerna/lerna/blob/54761ba26f8cb6d50d16a4c920d1a9594c19d6e9/README.md#independent-mode---independent).
- The tool should use [the same configuration `npm` uses to publish](https://github.com/lerna/lerna/blob/54761ba26f8cb6d50d16a4c920d1a9594c19d6e9/README.md#--registry-registry).
- The tool should not [use `npm link` or similar symlink-to-source technology](https://github.com/lerna/lerna/blob/54761ba26f8cb6d50d16a4c920d1a9594c19d6e9/README.md#bootstrap).
- The tool should not rely on package tests as they can be missing or incomplete.


#### References

- https://github.com/lerna/lerna
- https://github.com/sindresorhus/np
- https://github.com/semantic-release/semantic-release
- https://github.com/semantic-release/cracks
- https://github.com/bcherny/india , https://github.com/semantic-release/semantic-release/issues/66
- https://conventionalcommits.org/ , https://github.com/commitizen
- https://github.com/Microsoft/TypeScript/issues/6496
- https://twitter.com/dan_abramov/status/908371953844617218
- https://github.com/chbrown/npm-reallink
