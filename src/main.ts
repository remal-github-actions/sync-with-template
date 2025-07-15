/* eslint-disable import/no-named-as-default-member */

import * as core from '@actions/core'
import {context} from '@actions/github'
import type {components, operations} from '@octokit/openapi-types'
import {Ajv2020} from 'ajv/dist/2020.js'
import * as crypto from 'crypto'
import * as debug from 'debug'
import * as fs from 'fs'
import {PathLike} from 'fs'
import JSON5 from 'json5'
import path from 'path'
import picomatch from 'picomatch'
import {rimrafSync} from 'rimraf'
import {simpleGit, SimpleGit} from 'simple-git'
import * as tmp from 'tmp'
import {fileURLToPath, URL} from 'url'
import YAML from 'yaml'
import {adjustGitHubActionsCron} from './internal/adjustGitHubActionsCron.js'
import {Config} from './internal/config.js'
import {evalInScope} from './internal/evalInScope.js'
import {isTextFile} from './internal/isTextFile.js'
import {FilesTransformation, LocalTransformations} from './internal/local-transformations.js'
import {injectModifiableSections, ModifiableSections, parseModifiableSections} from './internal/modifiableSections.js'
import {newOctokitInstance} from './internal/octokit.js'
import * as schemas from './internal/schemas.no-coverage.js'

export type Repo = components['schemas']['full-repository']
export type PullRequest = components['schemas']['pull-request']
export type PullRequestSimple = components['schemas']['pull-request-simple']
export type NewPullRequest = operations['pulls/create']['requestBody']['content']['application/json']

/* * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * */

const __filename = fileURLToPath(import.meta.url)
core.info(__filename)

if (core.isDebug()) {
    debug.enable('simple-git,simple-git:*')
    process.env.DEBUG = [
        process.env.DEBUG ?? '',
        'simple-git',
        'simple-git:*',
    ].filter(it => it.length).join(',')
}

/* * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * */

const configFilePath = core.getInput('configFile', {required: true})
const filesToDeletePath = core.getInput('filesToDeleteFile', {required: false})
const transformationsFilePath = core.getInput('localTransformationsFile', {required: true})
const conventionalCommits = core.getInput('conventionalCommits', {required: false})?.toLowerCase() === 'true'
const dryRun = core.getInput('dryRun', {required: false}).toLowerCase() === 'true'
const templateRepositoryFullName = core.getInput('templateRepository', {required: false})

const githubToken = core.getInput('githubToken', {required: true})
core.setSecret(githubToken)

const octokit = newOctokitInstance(githubToken)

const syncBranchName = getSyncBranchName()

const PULL_REQUEST_LABEL = 'sync-with-template'
const SYNCHRONIZATION_EMAIL_SUFFIX = '+sync-with-template@users.noreply.github.com'
const DEFAULT_GIT_ENV: Record<string, string> = {
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASK_YESNO: 'false',
}

/* * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * */

async function run(): Promise<void> {
    try {
        const workspacePath = tmp.dirSync({unsafeCleanup: true}).name
        core.debug(`Workspace path: ${workspacePath}`)

        const repo = await octokit.repos.get({
            owner: context.repo.owner,
            repo: context.repo.repo,
        }).then(it => it.data)
        core.info(`Using ${repo.full_name} as the current repository`)

        const defaultBranchName = repo.default_branch
        core.info(`Using '${defaultBranchName}' as a default branch of the current repository`)

        const templateRepo = await getTemplateRepo(repo)
        if (templateRepo == null) {
            core.warning('Template repository name can\'t be retrieved: the current repository isn\'t created from a'
                + ' template and \'templateRepository\' input isn\'t set')
            return
        }
        core.info(`Using ${templateRepo.full_name} as a template repository`)


        const git = simpleGit(workspacePath)
            .env(DEFAULT_GIT_ENV)

        await core.group('Initializing the repository', async () => {
            await git.init()
            await git.addConfig('gc.auto', '0')
            await git.addConfig('user.useConfigOnly', 'true')
            await git.addConfig('diff.algorithm', 'patience')
            //await git.addConfig('core.pager', 'cat')
            await git.addConfig('fetch.recurseSubmodules', 'yes')

            const basicCredentials = Buffer.from(`x-access-token:${githubToken}`, 'utf8').toString('base64')
            core.setSecret(basicCredentials)
            const origins = [new URL(repo.svn_url).origin, new URL(templateRepo.svn_url).origin]
                .filter((v, i, a) => a.indexOf(v) === i)
            for (const origin of origins) {
                await git.addConfig(`http.${origin}/.extraheader`, `Authorization: basic ${basicCredentials}`)
            }

            const userName = repo.owner != null
                ? repo.owner.login
                : context.repo.owner
            core.info(`Git user name: ${userName}`)
            await git.addConfig('user.name', userName)

            const userEmail = repo.owner != null
                ? `${repo.owner.id}+${repo.owner.login}${SYNCHRONIZATION_EMAIL_SUFFIX}`
                : `${context.repo.owner}${SYNCHRONIZATION_EMAIL_SUFFIX}`
            core.info(`Git user email: ${userEmail}`)
            await git.addConfig('user.email', userEmail)

            core.info(`Adding 'origin' remote: ${repo.svn_url}`)
            await git.addRemote('origin', repo.svn_url)
            await git.fetch('origin', repo.default_branch)

            core.info(`Adding 'template' remote: ${templateRepo.svn_url}`)
            await git.addRemote('template', templateRepo.svn_url)
            await git.fetch('template', templateRepo.default_branch)
        })

        const repoBranches = await getRemoteBranches(git, 'origin')
        const originSha = await git.raw('rev-parse', `origin/${repo.default_branch}`).then(it => it.trim())
        const templateSha = await git.raw('rev-parse', `template/${templateRepo.default_branch}`).then(it => it.trim())

        core.info(`Creating '${syncBranchName}' branch from ${repo.html_url}/tree/${originSha}`)
        await git.raw('checkout', '--force', '-B', syncBranchName, originSha)


        const config: Config = await core.group(`Parsing config: ${configFilePath}`, async () => {
            const configPath = path.join(workspacePath, configFilePath)
            if (!fs.existsSync(configPath)) {
                core.info(`The repository doesn't have config ${configFilePath}, checking out from ${templateRepo.html_url}/blob/${templateSha}/${configFilePath}`)
                await git.raw('checkout', `template/${templateRepo.default_branch}`, '--', configFilePath)
            }


            const localConfigContent = fs.readFileSync(configPath, 'utf8')
            const localParsedConfig = YAML.parse(localConfigContent)

            let templateConfigContent: string | undefined
            try {
                templateConfigContent = await git.raw(
                    'show',
                    `template/${templateRepo.default_branch}:${configFilePath}`,
                )
            } catch (e) {
                core.warning('Error loading template config: ' + (e instanceof Error ? e : (e as any).toString()))
            }
            let templateParsedConfig = {}
            if (templateConfigContent?.length) {
                templateParsedConfig = YAML.parse(templateConfigContent)
            }

            const parsedConfig = {
                ...templateParsedConfig,
                ...localParsedConfig,
            }
            delete parsedConfig.$schema

            const ajv = new Ajv2020()
            const validate = ajv.compile(schemas.config)
            const valid = validate(parsedConfig)
            if (!valid) {
                throw new Error(`Config validation error: ${JSON.stringify(validate.errors, null, 2)}`)
            }

            return parsedConfig as unknown as Config
        })

        config.includes = config.includes ?? []
        config.includes.push(filesToDeletePath)

        config.excludes = config.excludes ?? []
        config.excludes.push(transformationsFilePath)
        await core.group('Parsed config', async () => {
            core.info(JSON.stringify(config, null, 2))
        })


        const localTransformations: LocalTransformations | undefined = await core.group(
            `Parsing local transformations: ${transformationsFilePath}`,
            async () => {
                const transformationsPath = path.join(workspacePath, transformationsFilePath)
                if (!fs.existsSync(transformationsPath)) {
                    core.info(`The repository doesn't have local transformations ${transformationsFilePath}`)
                    return undefined
                }

                const transformationsContent = fs.readFileSync(transformationsPath, 'utf8')
                const parsedTransformations = YAML.parse(transformationsContent)
                delete parsedTransformations.$schema

                const ajv = new Ajv2020()
                const validate = ajv.compile(schemas.transformations)
                const valid = validate(parsedTransformations)
                if (!valid) {
                    throw new Error(
                        `Transformations validation error: ${JSON.stringify(validate.errors, null, 2)}`,
                    )
                }

                return parsedTransformations as unknown as LocalTransformations
            },
        )

        if (localTransformations?.repositories != null) {
            const repoFullName = `${context.repo.owner}/${context.repo.repo}`
            if (!localTransformations.repositories.includes(repoFullName)) {
                throw new Error(`Local transformations file ${transformationsFilePath} doesn't contain`
                    + ` the current repository full name: ${repoFullName}`,
                )
            }
        }

        const allTransformations = localTransformations?.transformations != null
            ? [...localTransformations.transformations]
            : []

        allTransformations.push({
            name: 'Adjust GitHub actions cron',
            includes: ['.github/workflows/*.yml'],
            format: 'text',
            script: '#adjustGitHubActionsCron',
        })

        const ignoringTransformations = allTransformations.filter(it => it.ignore === true)
        const deletingTransformations = allTransformations.filter(it => it.delete === true)
        const transformations = allTransformations.filter(it => it.ignore !== true)

        function isTransforming(transformation: FilesTransformation, fileToSync: string): boolean {
            const includesMatcher = transformation.includes?.length
                ? picomatch(transformation.includes)
                : undefined
            if (includesMatcher != null && !includesMatcher(fileToSync)) {
                return false
            }

            const excludesMatcher = transformation.excludes?.length
                ? picomatch(transformation.excludes)
                : undefined
            if (excludesMatcher != null && excludesMatcher(fileToSync)) {
                return false
            }

            return true
        }


        const filesToSync = await core.group('Calculating files to sync', async () => {
            const includesMatcher = config.includes?.length
                ? picomatch(config.includes)
                : undefined
            const excludesMatcher = config.excludes?.length
                ? picomatch(config.excludes)
                : undefined
            return git.raw(
                'ls-tree',
                '-r',
                '--name-only',
                `remotes/template/${templateRepo.default_branch}`,
            )
                .then(content => content.split(/[\r\n]+/)
                    .map(line => line.trim())
                    .filter(line => line.length > 0),
                )
                .then(allFiles => {
                    return allFiles
                        .filter(file => includesMatcher == null || includesMatcher(file))
                        .filter(file => excludesMatcher == null || !excludesMatcher(file))
                        .sort()
                })
        })


        function hashFilesToSync(): string {
            const hash = crypto.createHash('sha512')
            for (const fileToSync of filesToSync) {
                const fileToSyncFullPath = path.join(workspacePath, fileToSync)
                if (fs.existsSync(fileToSyncFullPath)) {
                    core.info(fileToSync)
                    hash.update(fileToSync, 'utf8')
                    hash.update(fs.readFileSync(fileToSyncFullPath))
                    ;['R_OK', 'W_OK', 'X_OK'].forEach(accessConstant => {
                        const hasAccess = hasAccessToFile(fileToSyncFullPath, fs.constants[accessConstant])
                        hash.update(`${accessConstant}:${hasAccess}`, 'utf8')
                    })
                    hash.update('\n', 'utf8')
                } else {
                    core.info(`${fileToSync} - not found`)
                    hash.update(`${fileToSync}|deleted`, 'utf8')
                }
            }
            const result = hash.digest('hex')
            core.info(`Result hash: ${result}`)
            return result
        }

        const hashBefore = !repoBranches.hasOwnProperty(syncBranchName)
            ? undefined
            : await core.group('Hashing files before sync', async () => {
                await git.fetch('origin', syncBranchName)
                await git.raw('checkout', '--force', '-B', syncBranchName, `remotes/origin/${syncBranchName}`)
                const hash = hashFilesToSync()
                await git.raw('checkout', '--force', '-B', syncBranchName, `remotes/origin/${repo.default_branch}`)
                return hash
            })


        function isExcludedFromModifiableSections(fileToSync: string): boolean {
            const excludes = config['modifiable-sections-exclusions'] ?? []
            const excludesMatcher = excludes?.length
                ? picomatch(excludes)
                : undefined
            if (excludesMatcher != null && excludesMatcher(fileToSync)) {
                return true
            }

            return false
        }

        await core.group('Checking out template files', async () => {
            for (const fileToSync of filesToSync) {
                if (fileToSync === filesToDeletePath) {
                    // implemented separately
                    continue
                }

                core.info(`Synchronizing '${fileToSync}'`)

                if (isIgnoredByTransformations(fileToSync)) {
                    continue
                }

                if (isDeletedByTransformations(fileToSync)) {
                    core.info(`  Deleting by local transformations '${fileToSync}'`)
                    const fileToSyncPath = path.join(workspacePath, fileToSync)
                    if (fs.existsSync(fileToSyncPath)) {
                        fs.unlinkSync(fileToSyncPath)
                    }
                    continue
                }

                let modifiableSections: ModifiableSections | undefined = undefined
                if (!isExcludedFromModifiableSections(fileToSync)) {
                    core.info(`  Parsing modifiable sections for ${fileToSync}`)
                    modifiableSections = await parseModifiableSectionsFor(fileToSync)
                }

                core.info(`  Checking out ${templateRepo.html_url}/blob/${templateSha}/${fileToSync}`)
                await git.raw('checkout', `template/${templateRepo.default_branch}`, '--', fileToSync)

                core.info(`  Applying local transformations for ${fileToSync}`)
                applyLocalTransformations(fileToSync)

                if (modifiableSections) {
                    core.info(`  Applying modifiable sections for ${fileToSync}`)
                    applyModifiableSections(fileToSync, modifiableSections)
                }
            }

            do { // files to delete
                core.info(`Synchronizing '${filesToDeletePath}'`)
                const filesToDeletePathFull = path.join(workspacePath, filesToDeletePath)

                if (isDeletedByTransformations(filesToDeletePath)) {
                    core.info(`  Deleting by local transformations '${filesToDeletePath}'`)
                    if (fs.existsSync(filesToDeletePathFull)) {
                        fs.unlinkSync(filesToDeletePathFull)
                    }
                    break
                }

                const filesToDelete: string[] = []

                if (fs.existsSync(filesToDeletePathFull)) {
                    fs.readFileSync(filesToDeletePathFull, 'utf8')
                        .split(/[\r\n]+/)
                        .map(line => line.trim())
                        .filter(line => line.length)
                        .forEach(line => {
                            if (!filesToDelete.includes(line)) {
                                filesToDelete.push(line)
                            }
                        })
                }

                {
                    let templateFileToDeleteContent: string = ''
                    try {
                        templateFileToDeleteContent = await git.raw(
                            'show',
                            `template/${templateRepo.default_branch}:${filesToDeletePath}`,
                        )
                    } catch (_) {
                        // do nothing
                    }
                    templateFileToDeleteContent
                        .split(/[\r\n]+/)
                        .map(line => line.trim())
                        .filter(line => line.length)
                        .forEach(line => {
                            if (!filesToDelete.includes(line)) {
                                filesToDelete.push(line)
                            }
                        })
                }

                fs.mkdirSync(path.dirname(filesToDeletePathFull), {recursive: true})
                fs.writeFileSync(
                    filesToDeletePathFull,
                    filesToDelete.toSorted().join('\n') + '\n',
                    'utf8',
                )

                if (hasLocalTransformations(filesToDeletePath)) {
                    core.info(`  Applying local transformations for ${filesToDeletePath}`)
                    applyLocalTransformations(filesToDeletePath)

                    filesToDelete.length = 0
                    fs.readFileSync(filesToDeletePathFull, 'utf8')
                        .split(/[\r\n]+/)
                        .map(line => line.trim())
                        .forEach(line => {
                            if (!filesToDelete.includes(line)) {
                                filesToDelete.push(line)
                            }
                        })
                }

                if (!filesToDelete.length) {
                    core.info(`  No files to delete`)
                    if (fs.existsSync(filesToDeletePathFull)) {
                        fs.unlinkSync(filesToDeletePathFull)
                    }
                } else {
                    filesToDelete.forEach(fileToDelete => {
                        const fileToDeleteFull = path.join(workspacePath, fileToDelete)
                        if (fs.existsSync(fileToDeleteFull)) {
                            core.info(`  Deleting ${fileToDelete}`)
                            rimrafSync(fileToDeleteFull)
                        } else {
                            core.info(`  Already deleted: ${fileToDelete}`)
                        }
                    })
                }
                // eslint-disable-next-line no-constant-condition
            } while (false)

            function isIgnoredByTransformations(fileToSync: string): boolean {
                for (const transformation of ignoringTransformations) {
                    if (!isTransforming(transformation, fileToSync)) {
                        continue
                    }

                    core.info(`  Ignored by '${transformation.name}' local transformation`)
                    return true
                }

                return false
            }

            function isDeletedByTransformations(fileToSync: string): boolean {
                for (const transformation of deletingTransformations) {
                    if (!isTransforming(transformation, fileToSync)) {
                        continue
                    }

                    core.info(`  Deleted by '${transformation.name}' local transformation`)
                    return true
                }

                return false
            }

            async function parseModifiableSectionsFor(fileToSync: string): Promise<ModifiableSections | undefined> {
                const fullFilePath = path.join(workspacePath, fileToSync)
                if (!isTextFile(fullFilePath)) {
                    return undefined
                }

                const content = fs.readFileSync(fullFilePath, 'utf8')
                const modifiableSections = parseModifiableSections(content)
                if (Object.keys(modifiableSections).length) {
                    core.info(`  Found modifiable sections: ${Object.keys(modifiableSections).join(', ')}`)
                }
                return modifiableSections
            }

            function hasLocalTransformations(fileToSync: string): boolean {
                return transformations.some(transformation =>
                    isTransforming(transformation, fileToSync),
                )
            }

            function applyLocalTransformations(fileToSync: string) {
                for (const transformation of transformations) {
                    if (!isTransforming(transformation, fileToSync)) {
                        continue
                    }

                    let isTransformed = false
                    if (transformation.replaceWithFile != null) {
                        const replaceWithPath = path.join(workspacePath, transformation.replaceWithFile)
                        core.info(`  Executing '${transformation.name}' local transformation for ${fileToSync}`
                            + `: replacing with the content of ${transformation.replaceWithFile}`,
                        )
                        if (!fs.existsSync(replaceWithPath)) {
                            throw new Error(`File doesn't exist: ${transformation.replaceWithFile}`)
                        }
                        const fileToSyncPath = path.join(workspacePath, fileToSync)
                        fs.copyFileSync(replaceWithPath, fileToSyncPath)
                        isTransformed = true
                    }

                    if (transformation.replaceWithText != null) {
                        core.info(`  Executing '${transformation.name}' local transformation for ${fileToSync}`
                            + `: replacing with text`,
                        )
                        const fileToSyncPath = path.join(workspacePath, fileToSync)
                        fs.writeFileSync(fileToSyncPath, transformation.replaceWithText, 'utf8')
                        isTransformed = true
                    }

                    const transformationScript = transformation.script?.trim()
                    if (transformationScript != null) {
                        core.info(`  Executing '${transformation.name}' local transformation for ${fileToSync}`)
                        const fileToSyncPath = path.join(workspacePath, fileToSync)

                        let content: any = null
                        content = fs.readFileSync(fileToSyncPath, 'utf8')
                        let contentToFileContent: (value: any) => string = value => (value ?? '').toString()
                        if (transformation.format === 'text') {
                            // do nothing
                        } else if (transformation.format === 'json') {
                            content = JSON.parse(content)
                            contentToFileContent = value => JSON.stringify(value, null, transformation.indent ?? 2)
                        } else if (transformation.format === 'json5') {
                            content = JSON5.parse(content)
                            contentToFileContent = value => JSON5.stringify(value, null, transformation.indent ?? 2)
                        } else if (transformation.format === 'yaml') {
                            content = YAML.parse(content)
                            contentToFileContent = value => YAML.stringify(value, null, {
                                indent: transformation.indent ?? 2,
                                indentSeq: false,
                                lineWidth: 0,
                            })
                        } else if (transformation.format === 'list') {
                            content = content
                                .split(/[\r\n]+/)
                                .map(line => line.trim())
                                .filter(line => line.length)
                            contentToFileContent = value => (value as any[])
                                .filter(item => item != null)
                                .map(item => `${item}`.trim())
                                .filter((v, i, a) => a.indexOf(v) === i)
                                .toSorted()
                                .join('\n') + '\n'
                        } else {
                            throw new Error(`Unsupported transformation file format: ${transformation.format}`)
                        }

                        let transformedContent: any
                        if (transformationScript.startsWith('#')) {
                            const predefinedFilesTransformationScriptName = transformationScript.substring(1)
                            const predefinedFilesTransformationScript = predefinedFilesTransformationScripts[predefinedFilesTransformationScriptName]
                            if (predefinedFilesTransformationScript == null) {
                                throw new Error(`Unsupported transformation script: ${transformationScript}`)
                            }

                            transformedContent = predefinedFilesTransformationScript(content)

                        } else {
                            transformedContent = evalInScope(transformationScript, {
                                content,
                            })
                        }

                        const transformedContentString = contentToFileContent(transformedContent)
                        fs.writeFileSync(fileToSyncPath, transformedContentString, 'utf8')

                        isTransformed = true
                    }

                    if (!isTransformed) {
                        core.warning(`No transformation operations are defined for ${transformation.name}`)
                    }
                }
            }

            function applyModifiableSections(fileToSync: string, modifiableSections: ModifiableSections | undefined) {
                if (modifiableSections == null || !Object.keys(modifiableSections).length) {
                    return
                }

                core.info(`  Processing modifiable sections: ${Object.keys(modifiableSections).join(', ')}`)
                const fullFilePath = path.join(workspacePath, fileToSync)
                const content = fs.readFileSync(fullFilePath, 'utf8')
                const transformedContent = injectModifiableSections(content, modifiableSections)
                if (transformedContent !== content) {
                    fs.writeFileSync(fullFilePath, transformedContent, 'utf8')
                }
            }
        })


        let shouldBePushed = true
        if (hashBefore != null) {
            const hashAfter = await core.group('Hashing files after sync', async () => hashFilesToSync())
            if (hashBefore === hashAfter) {
                core.info('No files were changed')
                shouldBePushed = false
            }
        }


        if (!shouldBePushed && repoBranches.hasOwnProperty(syncBranchName)) {
            const comparison = await octokit.repos.compareCommits({
                owner: repo.owner.login,
                repo: repo.name,
                base: repo.default_branch,
                head: syncBranchName,
                per_page: 1,
            }).then(it => it.data)

            if (comparison.behind_by > 0) {
                core.info(`'${syncBranchName}' branch is behind by ${comparison.behind_by} commits`)
                shouldBePushed = true
            }
        }


        if (shouldBePushed) {
            await git.raw('add', '--all')
            const changedFiles = await git.status().then(response => response.files)

            if (changedFiles.length === 0) {
                core.info('No files were changed')
            } else {
                await core.group('Changes', async () => {
                    await git.raw('diff', '--cached').then(content => core.info(content))
                })
            }

            const prSyncMessage = changedFiles.length === 0
                ? 'Committing and synchronizing PR'
                : 'Committing and creating/synchronizing PR'
            await core.group(prSyncMessage, async () => {
                const openedPr = await getOpenedPullRequest()

                if (changedFiles.length === 0) {
                    core.info('No files were changed, nothing to commit')
                    if (!dryRun) {
                        if (openedPr != null) {
                            await closePullRequest(
                                openedPr,
                                'autoclosed',
                                `Autoclosing the PR, as no files will be changed after merging the changes`
                                + ` from \`${syncBranchName}\` branch into \`${defaultBranchName}\` branch.`,
                            )
                        }
                        if (repoBranches.hasOwnProperty(syncBranchName)) {
                            core.info(`Removing '${syncBranchName}' branch, as no files will be changed after merging the changes`
                                + ` from '${syncBranchName}' branch into '${defaultBranchName}' branch`,
                            )
                            await git.raw('push', '--delete', 'origin', syncBranchName)
                        }
                    }
                    return
                }

                if (dryRun) {
                    core.warning('Skipping Git push and PR creation, as dry run is enabled')
                    return
                }

                const commitMessage = getCommitMessage(templateRepo.full_name)
                await git.commit(commitMessage, {
                    '--allow-empty': null,
                })

                await git.raw('push', '--force', 'origin', syncBranchName)

                if (openedPr == null) {
                    let pullRequestTitle = `Merge template repository changes: ${templateRepo.full_name}`
                    if (conventionalCommits) {
                        pullRequestTitle = `chore(template): ${pullRequestTitle}`
                    }

                    const newPullRequest = await createPullRequest({
                        head: syncBranchName,
                        base: defaultBranchName,
                        title: pullRequestTitle,
                        body: 'Template repository changes.'
                            + '\n\nIf you close this PR, it will be recreated automatically.',
                        maintainer_can_modify: true,
                    })

                    core.info(`Pull request for '${syncBranchName}' branch has been created: ${newPullRequest.html_url}`)
                } else {
                    core.info(`Pull request for '${syncBranchName}' branch has been synchronized: ${openedPr.html_url}`)
                }
            })

        } else {
            const openedPr = await getOpenedPullRequest()
            if (openedPr == null) {
                if (dryRun) {
                    core.warning('Skipping PR creation, as dry run is enabled')
                    return
                }

                let pullRequestTitle = `Merge template repository changes: ${templateRepo.full_name}`
                if (conventionalCommits) {
                    pullRequestTitle = `chore(template): ${pullRequestTitle}`
                }

                const newPullRequest = await createPullRequest({
                    head: syncBranchName,
                    base: defaultBranchName,
                    title: pullRequestTitle,
                    body: 'Template repository changes.'
                        + '\n\nIf you close this PR, it will be recreated automatically.',
                    maintainer_can_modify: true,
                })

                core.info(`Pull request for '${syncBranchName}' branch has been created: ${newPullRequest.html_url}`)
            }
        }

    } catch (error) {
        core.setFailed(error instanceof Error ? error : `${error}`)
        throw error
    }
}

//noinspection JSIgnoredPromiseFromCall
run()

/* * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * */

const predefinedFilesTransformationScripts: Record<string, (content: any) => string> = {
    adjustGitHubActionsCron,
}

function getSyncBranchName(): string {
    const name = core.getInput('syncBranchName', {required: true})
    if (!conventionalCommits || name.toLowerCase().startsWith('chore/')) {
        return name
    } else {
        return `chore/${name}`
    }
}

function getCommitMessage(templateRepoName: string): string {
    let message = core.getInput('commitMessage', {required: true})

    message = message.replaceAll(/<template-repository>/g, templateRepoName)

    if (!conventionalCommits || message.toLowerCase().startsWith('chore(')) {
        return message
    } else {
        return `chore(template): ${message}`
    }
}

async function getTemplateRepo(currentRepo: Repo): Promise<Repo | undefined> {
    const templateRepoName = templateRepositoryFullName
    if (templateRepoName === currentRepo.template_repository?.full_name) {
        return currentRepo.template_repository as any as Repo

    } else if (!templateRepoName) {
        if (currentRepo.template_repository != null) {
            return currentRepo.template_repository as any as Repo
        }

    } else {
        const [owner, repo] = templateRepoName.split('/')
        return octokit.repos.get({owner, repo}).then(it => it.data)
    }

    return undefined
}

function hasAccessToFile(filePath: PathLike, mode: number): boolean {
    try {
        fs.accessSync(filePath, mode)
        return true
    } catch (_) {
        return false
    }
}

type BranchName = string
type CommitHash = string

async function getRemoteBranches(git: SimpleGit, remoteName: string): Promise<Record<BranchName, CommitHash>> {
    const branchPrefix = `refs/heads/`

    function removeBranchPrefix(branch: string): string {
        if (branch.startsWith(branchPrefix)) {
            return branch.substring(branchPrefix.length)
        } else {
            return branch
        }
    }

    return git.listRemote(['--exit-code', '--refs', '--heads', '--quiet', remoteName])
        .then(content => {
            return content.split('\n')
                .map(line => line.trim())
                .filter(line => line.length)
        })
        .then(lines => {
            const result: Record<BranchName, CommitHash> = {}
            lines.forEach(line => {
                const [hash, branch] = line.split('\t')
                    .map(it => it.trim())
                    .map(it => removeBranchPrefix(it))
                if (hash.length && branch.length) {
                    result[branch] = hash
                }
            })
            return result
        })
}

async function getOpenedPullRequest(): Promise<PullRequestSimple | undefined> {
    return octokit.paginate(octokit.pulls.list, {
        owner: context.repo.owner,
        repo: context.repo.repo,
        state: 'open',
        head: `${context.repo.owner}:${syncBranchName}`,
        sort: 'created',
        direction: 'desc',
    })
        .then(prs => prs.filter(pr => pr.head.ref === syncBranchName))
        .then(prs => {
            const promises = prs.map((pr, index) =>
                index === 0
                    ? Promise.resolve(pr)
                    : closePullRequest(pr, 'autoclosed redundant'),
            )
            return Promise.all(promises as Promise<any>[])
        })
        .then(promises => {
            if (promises.length) {
                return promises[0] as PullRequestSimple
            } else {
                return undefined
            }
        })
}

async function closePullRequest(
    pullRequest: PullRequest | PullRequestSimple,
    titleSuffix?: string,
    message?: string,
) {
    core.info(`Closing pull request ${pullRequest.html_url}`)

    if (message) {
        await octokit.issues.createComment({
            owner: context.repo.owner,
            repo: context.repo.repo,
            issue_number: pullRequest.number,
            body: message,
        })
    }

    return octokit.pulls.update({
        owner: context.repo.owner,
        repo: context.repo.repo,
        pull_number: pullRequest.number,
        state: 'closed',
        title: titleSuffix
            ? `${pullRequest.title} - ${titleSuffix}`
            : pullRequest.title,
    }).then(it => it.data)
}

async function createPullRequest(info: NewPullRequest) {
    const pullRequest = await octokit.pulls.create({
        ...info,
        owner: context.repo.owner,
        repo: context.repo.repo,
    }).then(it => it.data)

    await octokit.issues.addLabels({
        owner: context.repo.owner,
        repo: context.repo.repo,
        issue_number: pullRequest.number,
        labels: [PULL_REQUEST_LABEL],
    })

    return pullRequest
}
