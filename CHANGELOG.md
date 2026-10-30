# Changelog

## [1.2.0](https://github.com/incubateur-ademe/scalingo-watcher/compare/v1.1.2...v1.2.0) (2026-10-30)


### Nouveautés

* **apply:** verifier un deploiement, refuser une descente, tenir la quarantaine ([#30](https://github.com/incubateur-ademe/scalingo-watcher/issues/30)) ([919f926](https://github.com/incubateur-ademe/scalingo-watcher/commit/919f926f1e7e3b754aaa3e4a28357e6df1548c3c))

## [1.1.2](https://github.com/incubateur-ademe/scalingo-watcher/compare/v1.1.1...v1.1.2) (2026-10-30)


### Corrections

* **cve:** une version glissante .x n'est plus lue comme x.y.0 face aux failles ([#27](https://github.com/incubateur-ademe/scalingo-watcher/issues/27)) ([2e9dbb1](https://github.com/incubateur-ademe/scalingo-watcher/commit/2e9dbb1c5d138bc874384b4b34e6e07d27ae78fc))

## [1.1.1](https://github.com/incubateur-ademe/scalingo-watcher/compare/v1.1.0...v1.1.1) (2026-10-30)


### Corrections

* **renovate:** suivre Metabase par github-tags, les releases ne portent pas les correctifs ([#25](https://github.com/incubateur-ademe/scalingo-watcher/issues/25)) ([a1eaacf](https://github.com/incubateur-ademe/scalingo-watcher/commit/a1eaacf6e1274b8f297497efe81cca2f26c49173))

## [1.1.0](https://github.com/incubateur-ademe/scalingo-watcher/compare/v1.0.5...v1.1.0) (2026-10-30)


### Nouveautés

* une app en pause est lue a chaque passage, jamais ecrite ([#23](https://github.com/incubateur-ademe/scalingo-watcher/issues/23)) ([627cab8](https://github.com/incubateur-ademe/scalingo-watcher/commit/627cab8f77ca2e0862520a7a5b116cb64e1b6c9f))


### Corrections

* **fgp:** scopes des blobs bornes app par app ([#22](https://github.com/incubateur-ademe/scalingo-watcher/issues/22)) ([7d00820](https://github.com/incubateur-ademe/scalingo-watcher/commit/7d00820f997c7acc6d050062926aad6bd7f53441))
* **init:** ecarter une app liee a son depot sans branche ([#21](https://github.com/incubateur-ademe/scalingo-watcher/issues/21)) ([ae17718](https://github.com/incubateur-ademe/scalingo-watcher/commit/ae1771823a8ea281ae981672e5836adb6ff61183))

## [1.0.5](https://github.com/incubateur-ademe/scalingo-watcher/compare/v1.0.4...v1.0.5) (2026-10-21)


### Corrections

* `defaults.policy` décide désormais de l'automerge des versions Metabase : `minor: pr` garde les correctifs en PR, `major: auto` fusionne seules les montées fonctionnelles. Sans politique, rien ne change. ([#19](https://github.com/incubateur-ademe/scalingo-watcher/issues/19)) ([57fcc7e](https://github.com/incubateur-ademe/scalingo-watcher/commit/57fcc7e59e06726db2f137975d96b0d7e6705b88))
* `--validate` refuse une politique que Renovate ne relit pas, écrite en style flow `{ minor: …, major: … }` par exemple : la réécrire en bloc.
* Renovate fait avancer les versions de l'outil citées dans la documentation et dans le `$schema` du manifeste.
* `fgp.md` : la génération manuelle des blobs échoue sur une erreur du proxy, au lieu d'écrire `undefined`.
* En local, le chemin du répertoire de sortie s'affiche.

## [1.0.4](https://github.com/incubateur-ademe/scalingo-watcher/compare/v1.0.3...v1.0.4) (2026-10-05)


### Corrections

* **signaler:** notification en TypeScript, message clair pour un parc sain ([#13](https://github.com/incubateur-ademe/scalingo-watcher/issues/13)) ([d8aaac9](https://github.com/incubateur-ademe/scalingo-watcher/commit/d8aaac9e364e1c01aa88f9b37b8e8aef13d74cab))

## [1.0.3](https://github.com/incubateur-ademe/scalingo-watcher/compare/v1.0.2...v1.0.3) (2026-10-05)


### Corrections

* ramener a un jour la quarantaine des mises a jour de l'outil ([#9](https://github.com/incubateur-ademe/scalingo-watcher/issues/9)) ([2b3f921](https://github.com/incubateur-ademe/scalingo-watcher/commit/2b3f9217bcaa8539f25ecd2c3d21090aa4c102eb))

## [1.0.2](https://github.com/incubateur-ademe/scalingo-watcher/compare/v1.0.1...v1.0.2) (2026-10-05)


### Corrections

* **deps:** bump pnpm/action-setup from 6.0.10 to 6.1.0 in /actions/setup in the actions group across 1 directory ([#6](https://github.com/incubateur-ademe/scalingo-watcher/issues/6)) ([793f2ec](https://github.com/incubateur-ademe/scalingo-watcher/commit/793f2ec7d1cd64dfa12100c91223f8773e1ebcad))
* **deps:** bump yaml from 2.9.0 to 2.9.1 in the production group ([#7](https://github.com/incubateur-ademe/scalingo-watcher/issues/7)) ([6a3d0df](https://github.com/incubateur-ademe/scalingo-watcher/commit/6a3d0dfd2bf71ed0012d641967f452cec703fa47))
* traiter les alertes de sécurité CodeQL et Dependabot ([#4](https://github.com/incubateur-ademe/scalingo-watcher/issues/4)) ([3cddf1e](https://github.com/incubateur-ademe/scalingo-watcher/commit/3cddf1e0ff567435c627740b5e35063bb510a187))

## [1.0.1](https://github.com/incubateur-ademe/scalingo-watcher/compare/v1.0.0...v1.0.1) (2026-10-05)


### Corrections

* mapper les secrets de l'environment dans les appelants du template ([#2](https://github.com/incubateur-ademe/scalingo-watcher/issues/2)) ([066ed88](https://github.com/incubateur-ademe/scalingo-watcher/commit/066ed88c83a78cf1467e8dcea203979a1138be60))

## 1.0.0 (2026-10-04)


### Nouveautés

* premiere version publique de scalingo-watcher ([6b68b91](https://github.com/incubateur-ademe/scalingo-watcher/commit/6b68b91a9954d0efca5d9932d725a36e699d9517))
